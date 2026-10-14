create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

alter table public.send_log drop constraint if exists send_log_status_check;
alter table public.send_log
  add constraint send_log_status_check
  check (status in ('sent', 'failed', 'skipped', 'deferred'));

create table public.sender_heartbeats (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  claimed_count integer not null check (claimed_count >= 0),
  sent_count integer not null check (sent_count >= 0),
  failed_count integer not null check (failed_count >= 0),
  deferred_count integer not null check (deferred_count >= 0)
);

create table public.reconnect_email_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recipient text not null,
  reconnect_url text not null,
  created_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  delivered_at timestamptz,
  last_error text
);

alter table public.sender_heartbeats enable row level security;
alter table public.reconnect_email_outbox enable row level security;
revoke all on public.sender_heartbeats, public.reconnect_email_outbox from anon, authenticated;
grant all on public.sender_heartbeats, public.reconnect_email_outbox to service_role;

create or replace function public.claim_due_schedules(p_limit integer default 50)
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
  google_email text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select s.id
    from public.schedules s
    join public.gmail_connections c on c.user_id = s.user_id and c.status = 'connected'
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
    s."to", s.cc, s.bcc, s.rrule, s.timezone, c.encrypted_refresh_token, c.google_email
  from claimed s
  join public.gmail_connections c on c.user_id = s.user_id and c.status = 'connected'
  order by s.next_send_at, s.id;
$$;

create or replace function public.complete_due_schedule(
  p_schedule_id uuid,
  p_scheduled_for timestamptz,
  p_status text,
  p_next_send_at timestamptz,
  p_message_id text default null,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('sent', 'failed', 'deferred') then
    raise exception 'invalid send status';
  end if;

  update public.schedules
  set status = case when p_next_send_at is null then 'paused' else 'active' end,
      next_send_at = coalesce(p_next_send_at, next_send_at),
      updated_at = now()
  where id = p_schedule_id and status = 'sending';
  if not found then raise exception 'schedule is not claimed'; end if;

  insert into public.send_log (
    schedule_id, user_id, scheduled_for, attempted_at, status, gmail_message_id, error_code
  )
  select s.id, s.user_id, p_scheduled_for, now(), p_status, p_message_id, p_error_code
  from public.schedules s where s.id = p_schedule_id;
end;
$$;

create or replace function public.mark_gmail_reconnect_needed(
  p_schedule_id uuid,
  p_user_id uuid,
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
    where user_id = p_user_id and status = 'connected';
  get diagnostics connection_changed = row_count;
  update public.schedules set status = 'paused', updated_at = now()
    where user_id = p_user_id and status in ('active', 'sending');
  insert into public.send_log (schedule_id, user_id, scheduled_for, attempted_at, status, error_code)
  values (p_schedule_id, p_user_id, p_scheduled_for, now(), 'failed', 'invalid_grant');
  if connection_changed > 0 then
    insert into public.reconnect_email_outbox (user_id, recipient, reconnect_url)
    values (p_user_id, p_recipient, p_reconnect_url);
  end if;
end;
$$;

revoke all on function public.claim_due_schedules(integer) from public, anon, authenticated;
revoke all on function public.complete_due_schedule(uuid, timestamptz, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.mark_gmail_reconnect_needed(uuid, uuid, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.claim_due_schedules(integer) to service_role;
grant execute on function public.complete_due_schedule(uuid, timestamptz, text, timestamptz, text, text) to service_role;
grant execute on function public.mark_gmail_reconnect_needed(uuid, uuid, timestamptz, text, text) to service_role;

-- Set Vault secrets named project_url and sender_cron_secret before enabling delivery.
-- The same daily job deliberately invokes the DB-writing function so Free projects
-- receive a predictable API-backed database write even if pg_cron itself is not
-- counted as user activity by the platform's inactivity detector.
select cron.schedule(
  'recurmail-send-due-every-minute',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-due',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-recurmail-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sender_cron_secret')
      ),
      body := jsonb_build_object('source', 'pg_cron')
    );
  $job$
);

select cron.schedule(
  'recurmail-daily-keepalive',
  '17 3 * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-due',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-recurmail-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sender_cron_secret')
      ),
      body := jsonb_build_object('source', 'daily_keepalive')
    );
  $job$
);
