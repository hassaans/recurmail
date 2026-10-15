create extension if not exists pgtap with schema extensions;

begin;
select plan(28);

create temporary table sender_metrics_baseline on commit preserve rows as
select
  count(*) filter (where status = 'failed' and attempted_at >= now() - interval '1 hour')::integer as failed_last_hour,
  count(*) filter (where status in ('sent', 'failed') and attempted_at >= now() - interval '1 hour')::integer as attempted_last_hour
from public.send_log;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000006', 'sender@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (id, user_id, google_email, encrypted_refresh_token, status)
values ('40000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000006', 'sender@example.test', 'ciphertext', 'connected');
insert into public.schedules (
  id, user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status
) values
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000006', 'one', 'body', array['one@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000006', 'two', 'body', array['two@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('10000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000006', '40000000-0000-4000-8000-000000000006', 'three', 'body', array['three@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active');

commit;
begin;

select ok(pg_get_functiondef('public.claim_due_schedules(integer)'::regprocedure) ilike '%skip locked%', 'claim function uses SKIP LOCKED');
select is(has_function_privilege('anon', 'public.get_admin_metrics()', 'EXECUTE'), false, 'anon cannot read admin metrics');
select is(has_function_privilege('authenticated', 'public.get_admin_metrics()', 'EXECUTE'), false, 'signed-in users cannot read admin metrics');
select is(has_function_privilege('service_role', 'public.get_admin_metrics()', 'EXECUTE'), true, 'service role can read admin metrics');
select ok((select count(*) = 2 from cron.job where jobname in ('recurmail-send-due-every-minute', 'recurmail-daily-keepalive')), 'both send-due cron jobs are installed');
select ok(not exists (select 1 from cron.job where command ilike '%service_role_key%' or command ilike '%Authorization%'), 'cron commands do not store an API key or Authorization header');
select is((select count(*) from cron.job where jobname in ('recurmail-send-due-every-minute', 'recurmail-daily-keepalive') and command ilike '%timeout_milliseconds := 30000%'), 2::bigint, 'send-due cron calls allow 30 seconds before timing out');
select is((select count(*) from cron.job where jobname = 'recurmail-send-due-every-minute' and command ilike '%''source'', ''pg_cron''%'), 1::bigint, 'minute cron job still identifies itself as pg_cron');
select is((select count(*) from cron.job where jobname = 'recurmail-daily-keepalive' and command ilike '%''source'', ''daily_keepalive''%'), 1::bigint, 'daily cron job still identifies itself as the keepalive');
select is((select count(*) from cron.job where jobname = 'recurmail-prune-cron-history' and schedule = '41 3 * * *' and command ilike '%delete from cron.job_run_details%7 days%'), 1::bigint, 'cron history older than a week is pruned daily');
select is((select schedule_id from public.claim_due_schedules(1)), '10000000-0000-4000-8000-000000000006'::uuid, 'first claim takes the earliest due schedule');
select is((select schedule_id from public.claim_due_schedules(1)), '10000000-0000-4000-8000-000000000007'::uuid, 'second claim takes the next due schedule');
select is((select count(*) from public.claim_due_schedules(1)), 1::bigint, 'third claim gets the remaining schedule');
select is((select count(*) from public.claim_due_schedules(1)), 0::bigint, 'no schedule is claimed twice');
select is((select count(*) from public.schedules where status = 'sending'), 3::bigint, 'claimed schedules are atomically marked sending');

select public.complete_due_schedule(
  '10000000-0000-4000-8000-000000000006', now() - interval '1 minute', 'sent', now() + interval '1 day', 'gmail-message-1', null
);
select is((select count(*) from public.send_log where status = 'sent' and gmail_message_id = 'gmail-message-1'), 1::bigint, 'successful send writes send_log');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000006'), 'active', 'successful schedule advances and remains active');
select public.complete_due_schedule(
  '10000000-0000-4000-8000-000000000007', now() - interval '1 minute', 'deferred', now() + interval '1 hour', null, 'gmail_quota_deferred'
);
select is((select count(*) from public.send_log where status = 'deferred' and error_code = 'gmail_quota_deferred'), 1::bigint, 'quota is recorded as deferred');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000007'), 'active', 'quota does not pause schedule');

select public.mark_gmail_reconnect_needed(
  '10000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000006',
  '40000000-0000-4000-8000-000000000006',
  now() - interval '1 minute',
  'sender@example.test',
  'https://recurmail.example.test/dashboard?gmail=failed'
);
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000008'), 'paused', 'invalid grant pauses the schedule');
select is((select status from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000006'), 'needs_reconnect', 'connection requires reconnect');
select is((select count(*) from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000006' and status = 'queued'), 1::bigint, 'reconnect email is queued');
select is((select count(*) from public.send_log where status = 'failed' and error_code = 'invalid_grant'), 1::bigint, 'invalid grant attempt is recorded failed');
select is((public.get_admin_metrics()->>'failed_last_hour')::integer, (select failed_last_hour + 1 from sender_metrics_baseline), 'admin failed count includes the new failed send');
select is((public.get_admin_metrics()->>'attempted_last_hour')::integer, (select attempted_last_hour + 2 from sender_metrics_baseline), 'admin attempted count includes the new sent and failed sends');
select is((public.get_admin_metrics()->>'failure_rate_last_hour')::numeric, (select round((failed_last_hour + 1)::numeric / (attempted_last_hour + 2)::numeric, 4) from sender_metrics_baseline), 'admin failure rate includes failed over sent and failed attempts from the last hour');
select public.mark_gmail_reconnect_needed(
  '10000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000006',
  '40000000-0000-4000-8000-000000000006',
  now() - interval '1 minute',
  'sender@example.test',
  'https://recurmail.example.test/dashboard?gmail=failed'
);
select is((select count(*) from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000006'), 1::bigint, 'reconnect outbox queues only one email per connection outage');

insert into public.sender_heartbeats (id, started_at, finished_at, claimed_count, sent_count, failed_count, deferred_count)
values ('30000000-0000-4000-8000-000000000006', now() - interval '1 second', now(), 3, 1, 1, 1);
select is((select count(*) from public.sender_heartbeats where claimed_count = 3 and sent_count = 1 and failed_count = 1 and deferred_count = 1), 1::bigint, 'sender run writes heartbeat counts');

delete from auth.users where id = '00000000-0000-4000-8000-000000000006';
delete from public.sender_heartbeats where id = '30000000-0000-4000-8000-000000000006';
select * from finish(true);
commit;
