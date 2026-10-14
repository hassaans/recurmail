create or replace function public.reclaim_stale_sending(p_older_than interval default interval '10 minutes')
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
  select s.id, s.user_id, s.next_send_at, s.subject, s.body_text, s.body_html,
    s."to", s.cc, s.bcc, s.rrule, s.timezone, c.encrypted_refresh_token, c.google_email
  from public.schedules s
  join public.gmail_connections c on c.user_id = s.user_id
  where s.status = 'sending'
    and s.updated_at < now() - coalesce(p_older_than, interval '10 minutes')
  order by s.updated_at, s.id
  for update of s skip locked;
$$;

create or replace function public.record_sender_failure(
  p_schedule_id uuid,
  p_scheduled_for timestamptz,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.send_log (schedule_id, user_id, scheduled_for, attempted_at, status, error_code)
  select s.id, s.user_id, p_scheduled_for, now(), 'failed', p_error_code
  from public.schedules s
  where s.id = p_schedule_id and s.status = 'sending';
  if not found then raise exception 'schedule is not sending'; end if;
end;
$$;

revoke all on function public.reclaim_stale_sending(interval) from public, anon, authenticated;
revoke all on function public.record_sender_failure(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.reclaim_stale_sending(interval) to service_role;
grant execute on function public.record_sender_failure(uuid, timestamptz, text) to service_role;
