alter table public.reconnect_email_outbox
  drop constraint if exists reconnect_email_outbox_status_check;
alter table public.reconnect_email_outbox
  add constraint reconnect_email_outbox_status_check
  check (status in ('queued', 'sending', 'sent', 'failed'));
alter table public.reconnect_email_outbox
  add column attempts integer not null default 0 check (attempts between 0 and 3),
  add column claimed_at timestamptz;

alter table public.sender_heartbeats
  add column notices_sent integer not null default 0 check (notices_sent >= 0),
  add column notices_failed integer not null default 0 check (notices_failed >= 0);

create or replace function public.claim_reconnect_email_outbox(p_limit integer default 20)
returns table (id uuid, recipient text, reconnect_url text, attempts integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.reconnect_email_outbox
  set status = case when attempts >= 3 then 'failed' else 'queued' end,
      claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  return query
  with due as (
    select o.id
    from public.reconnect_email_outbox o
    where o.status = 'queued' and o.attempts < 3
    order by o.created_at, o.id
    for update skip locked
    limit greatest(0, least(coalesce(p_limit, 20), 20))
  )
  update public.reconnect_email_outbox o
  set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
  from due
  where o.id = due.id
  returning o.id, o.recipient, o.reconnect_url, o.attempts;
end;
$$;

create or replace function public.mark_reconnect_email_sent(p_notice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.reconnect_email_outbox
  set status = 'sent', delivered_at = now(), claimed_at = null, last_error = null
  where id = p_notice_id and status = 'sending';
  if not found then raise exception 'notice is not claimed'; end if;
end;
$$;

create or replace function public.mark_reconnect_email_failed(
  p_notice_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_error_code !~ '^(resend_http_[0-9]{3}|resend_network_error)$' then
    raise exception 'invalid reconnect notice error code';
  end if;
  update public.reconnect_email_outbox
  set status = case when attempts >= 3 then 'failed' else 'queued' end,
      last_error = p_error_code, claimed_at = null
  where id = p_notice_id and status = 'sending';
  if not found then raise exception 'notice is not claimed'; end if;
end;
$$;

revoke all on function public.claim_reconnect_email_outbox(integer) from public, anon, authenticated;
revoke all on function public.mark_reconnect_email_sent(uuid) from public, anon, authenticated;
revoke all on function public.mark_reconnect_email_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_reconnect_email_outbox(integer) to service_role;
grant execute on function public.mark_reconnect_email_sent(uuid) to service_role;
grant execute on function public.mark_reconnect_email_failed(uuid, text) to service_role;
