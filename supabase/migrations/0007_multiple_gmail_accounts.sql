-- Several Gmail accounts per user. Each schedule names the connection it
-- sends from, and the sender joins on that connection instead of the user.

-- 1. Connections: one row per (user, account) instead of one row per user.
alter table public.gmail_connections drop constraint gmail_connections_user_id_key;
alter table public.gmail_connections
  add constraint gmail_connections_id_user_id_key unique (id, user_id);
create unique index gmail_connections_user_id_lower_email_key
  on public.gmail_connections (user_id, lower(google_email));

-- At most 10 accounts per user. The advisory lock serialises concurrent
-- inserts for the same user so two requests cannot both pass the count.
create or replace function public.enforce_gmail_connection_cap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('gmail_connections_cap'), hashtext(new.user_id::text));
  if (select count(*) from public.gmail_connections where user_id = new.user_id) >= 10 then
    raise exception 'A user can connect at most 10 Gmail accounts'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger gmail_connections_cap
  before insert on public.gmail_connections
  for each row execute function public.enforce_gmail_connection_cap();

-- 2. Schedules name their sender. Deleting the connection clears the sender;
-- the trigger below pauses the schedule in the same statement so the check
-- constraint in step 4 holds through the referential action.
alter table public.schedules add column gmail_connection_id uuid;
alter table public.schedules
  add constraint schedules_gmail_connection_id_fkey
  foreign key (gmail_connection_id, user_id)
  references public.gmail_connections (id, user_id)
  on delete set null (gmail_connection_id);
create index schedules_gmail_connection_id_idx
  on public.schedules (gmail_connection_id);

create or replace function public.pause_schedule_without_sender()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.gmail_connection_id is null
    and old.gmail_connection_id is not null
    and new.status in ('active', 'sending') then
    new.status := 'paused';
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger schedules_pause_without_sender
  before update of gmail_connection_id on public.schedules
  for each row execute function public.pause_schedule_without_sender();

-- 3. Backfill from the user's single existing connection, then pause any
-- schedule that still has no sender. The notice reports how many rows hit.
update public.schedules s
set gmail_connection_id = c.id
from public.gmail_connections c
where c.user_id = s.user_id and s.gmail_connection_id is null;

do $$
declare
  paused_count integer;
begin
  update public.schedules
  set status = 'paused', updated_at = now()
  where gmail_connection_id is null and status in ('active', 'sending');
  get diagnostics paused_count = row_count;
  raise notice '0007: paused % schedule(s) that had no Gmail connection', paused_count;
end;
$$;

-- 4. A schedule without a sender can only be paused.
alter table public.schedules
  add constraint schedules_sender_required_check
  check (status = 'paused' or gmail_connection_id is not null);

-- 5. Sender RPCs join on the schedule's connection and return its id. The
-- return type changes, so the functions are dropped and recreated.
drop function public.claim_due_schedules(integer);
create function public.claim_due_schedules(p_limit integer default 50)
returns table (
  schedule_id uuid,
  user_id uuid,
  scheduled_for timestamptz,
  subject text,
  body_text text,
  body_html text,
  "to" text[],
  cc text[],
  bcc text[],
  rrule text,
  timezone text,
  encrypted_refresh_token text,
  google_email text,
  gmail_connection_id uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select s.id
    from public.schedules s
    join public.gmail_connections c on c.id = s.gmail_connection_id and c.status = 'connected'
    where s.status = 'active' and s.next_send_at <= now()
    order by s.next_send_at, s.id
    for update of s skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  ), claimed as (
    update public.schedules s
    set status = 'sending', updated_at = now()
    from due d
    where s.id = d.id
    returning s.*
  )
  select s.id, s.user_id, s.next_send_at, s.subject, s.body_text, s.body_html,
    s."to", s.cc, s.bcc, s.rrule, s.timezone, c.encrypted_refresh_token, c.google_email, c.id
  from claimed s
  join public.gmail_connections c on c.id = s.gmail_connection_id and c.status = 'connected'
  order by s.next_send_at, s.id;
$$;

drop function public.reclaim_stale_sending(interval);
create function public.reclaim_stale_sending(p_older_than interval default interval '10 minutes')
returns table (
  schedule_id uuid,
  user_id uuid,
  scheduled_for timestamptz,
  subject text,
  body_text text,
  body_html text,
  "to" text[],
  cc text[],
  bcc text[],
  rrule text,
  timezone text,
  encrypted_refresh_token text,
  google_email text,
  gmail_connection_id uuid
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.user_id, s.next_send_at, s.subject, s.body_text, s.body_html,
    s."to", s.cc, s.bcc, s.rrule, s.timezone, c.encrypted_refresh_token, c.google_email, c.id
  from public.schedules s
  join public.gmail_connections c on c.id = s.gmail_connection_id
  where s.status = 'sending'
    and s.updated_at < now() - coalesce(p_older_than, interval '10 minutes')
  order by s.updated_at, s.id
  for update of s skip locked;
$$;

-- 6. An invalid grant affects one connection: mark it, pause only the
-- schedules that send from it, and queue one reconnect email to that account.
drop function public.mark_gmail_reconnect_needed(uuid, uuid, timestamptz, text, text);
create function public.mark_gmail_reconnect_needed(
  p_schedule_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_scheduled_for timestamptz,
  p_recipient text,
  p_reconnect_url text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  connection_changed integer;
begin
  update public.gmail_connections set status = 'needs_reconnect'
    where id = p_connection_id and user_id = p_user_id and status = 'connected';
  get diagnostics connection_changed = row_count;
  update public.schedules set status = 'paused', updated_at = now()
    where gmail_connection_id = p_connection_id and user_id = p_user_id
      and status in ('active', 'sending');
  insert into public.send_log (schedule_id, user_id, scheduled_for, attempted_at, status, error_code)
  values (p_schedule_id, p_user_id, p_scheduled_for, now(), 'failed', 'invalid_grant');
  if connection_changed > 0 then
    insert into public.reconnect_email_outbox (user_id, recipient, reconnect_url)
    values (p_user_id, p_recipient, p_reconnect_url);
  end if;
end;
$$;

revoke all on function public.claim_due_schedules(integer) from public, anon, authenticated;
revoke all on function public.reclaim_stale_sending(interval) from public, anon, authenticated;
revoke all on function public.mark_gmail_reconnect_needed(uuid, uuid, uuid, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.enforce_gmail_connection_cap() from public, anon, authenticated;
revoke all on function public.pause_schedule_without_sender() from public, anon, authenticated;
grant execute on function public.claim_due_schedules(integer) to service_role;
grant execute on function public.reclaim_stale_sending(interval) to service_role;
grant execute on function public.mark_gmail_reconnect_needed(uuid, uuid, uuid, timestamptz, text, text) to service_role;
