create extension if not exists pgtap with schema extensions;

begin;
select plan(17);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000009', 'recovery@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (id, user_id, google_email, encrypted_refresh_token, status)
values ('40000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000009', 'recovery@example.test', 'ciphertext', 'connected');
insert into public.schedules (
  id, user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status, updated_at
) values
  ('10000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000009', 'stale', 'body', array['stale@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '20 minutes', 'sending', now() - interval '20 minutes'),
  ('10000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000009', 'fresh', 'body', array['fresh@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '2 minutes', 'sending', now() - interval '2 minutes'),
  ('10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000009', '40000000-0000-4000-8000-000000000009', 'active', 'body', array['active@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '20 minutes', 'active', now() - interval '20 minutes');

select public.record_sender_failure('10000000-0000-4000-8000-000000000009', now() - interval '20 minutes', 'post_send_store_failed');
select is((select count(*) from public.send_log where schedule_id = '10000000-0000-4000-8000-000000000009' and error_code = 'post_send_store_failed'), 1::bigint, 'post-send store failure is recorded');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000009'), 'sending', 'post-send failure log leaves the schedule for stale recovery');

select is(
  (select schedule_id from public.reclaim_stale_sending(interval '10 minutes')),
  '10000000-0000-4000-8000-000000000009'::uuid,
  'reclaims the stale sending schedule'
);
select is(
  (select count(*) from public.reclaim_stale_sending(interval '10 minutes')),
  1::bigint,
  'fresh sending and non-sending schedules are excluded'
);
select is(
  (select count(*) from public.reclaim_stale_sending(interval '10 minutes') where schedule_id = '10000000-0000-4000-8000-000000000010'),
  0::bigint,
  'fresh sending schedule is not returned'
);
select is(
  (select count(*) from public.reclaim_stale_sending(interval '10 minutes') where schedule_id = '10000000-0000-4000-8000-000000000011'),
  0::bigint,
  'non-sending schedule is not returned'
);
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000009'), 'sending', 'recovery selection does not change schedule status');
select ok((select updated_at < now() - interval '19 minutes' from public.schedules where id = '10000000-0000-4000-8000-000000000009'), 'recovery selection does not change the stale claim timestamp');
select ok(not has_function_privilege('anon', 'public.reclaim_stale_sending(interval)', 'EXECUTE'), 'anon cannot reclaim sending schedules');
select ok(not has_function_privilege('authenticated', 'public.reclaim_stale_sending(interval)', 'EXECUTE'), 'authenticated cannot reclaim sending schedules');
select ok(has_function_privilege('service_role', 'public.reclaim_stale_sending(interval)', 'EXECUTE'), 'service_role can reclaim sending schedules');
select ok((select prosecdef from pg_proc where oid = 'public.reclaim_stale_sending(interval)'::regprocedure), 'recovery function runs as security definer');
select is(pg_get_function_result('public.reclaim_stale_sending(interval)'::regprocedure), pg_get_function_result('public.claim_due_schedules(integer)'::regprocedure), 'recovery returns the same schedule columns as claim');
select ok(position('for update' in lower(pg_get_functiondef('public.reclaim_stale_sending(interval)'::regprocedure))) > 0, 'recovery locks selected rows');
select ok(position('skip locked' in lower(pg_get_functiondef('public.reclaim_stale_sending(interval)'::regprocedure))) > 0, 'recovery skips rows claimed by another run');
select is((select count(*) from cron.job where jobname = 'recurmail-send-due-every-minute' and command ilike '%sender_cron_secret%'), 1::bigint, 'minute cron job reads the scheduler secret from Vault');
select is((select count(*) from cron.job where jobname = 'recurmail-daily-keepalive' and command ilike '%sender_cron_secret%'), 1::bigint, 'daily cron job reads the scheduler secret from Vault');

delete from auth.users where id = '00000000-0000-4000-8000-000000000009';
select * from finish(true);
commit;
