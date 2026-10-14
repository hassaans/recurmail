alter table public.sender_heartbeats
  add column failure_rate_last_hour numeric check (failure_rate_last_hour between 0 and 1),
  add column failed_last_hour integer check (failed_last_hour >= 0),
  add column attempted_last_hour integer check (attempted_last_hour >= 0);

create or replace function public.get_admin_metrics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with send_counts as (
    select
      count(*) filter (where sl.status = 'failed' and sl.attempted_at >= now() - interval '1 hour')::integer as failed_last_hour,
      count(*) filter (where sl.status in ('sent', 'failed') and sl.attempted_at >= now() - interval '1 hour')::integer as attempted_last_hour,
      count(*) filter (where sl.status = 'sent' and sl.attempted_at >= now() - interval '24 hours')::integer as sends_last_24_hours
    from public.send_log sl
    where sl.attempted_at >= now() - interval '24 hours'
  )
  select jsonb_build_object(
    'signed_up_users', (select count(*)::integer from auth.users),
    'connected_gmail_accounts', (select count(*)::integer from public.gmail_connections where status = 'connected'),
    'active_schedules', (select count(*)::integer from public.schedules where status = 'active'),
    'sends_last_24_hours', send_counts.sends_last_24_hours,
    'kept_sending_30_days', (
      select count(distinct s.user_id)::integer
      from public.schedules s
      where s.created_at <= now() - interval '30 days'
        and s.status = 'active'
        and exists (
          select 1 from public.send_log sl
          where sl.schedule_id = s.id
            and sl.status = 'sent'
            and sl.attempted_at >= now() - interval '7 days'
        )
    ),
    'failed_last_hour', send_counts.failed_last_hour,
    'attempted_last_hour', send_counts.attempted_last_hour,
    'failure_rate_last_hour', case
      when send_counts.attempted_last_hour = 0 then 0
      else round(send_counts.failed_last_hour::numeric / send_counts.attempted_last_hour::numeric, 4)
    end
  )
  from send_counts;
$$;

revoke all on function public.get_admin_metrics() from public, anon, authenticated;
grant execute on function public.get_admin_metrics() to service_role;
