create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

begin;
select plan(17);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000006', 'sender@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token, status)
values ('00000000-0000-4000-8000-000000000006', 'sender@example.test', 'ciphertext', 'connected');
insert into public.schedules (
  id, user_id, subject, body_text, "to", rrule, timezone, next_send_at, status
) values
  ('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000006', 'one', 'body', array['one@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006', 'two', 'body', array['two@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('10000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000006', 'three', 'body', array['three@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active');

commit;
begin;

select ok(pg_get_functiondef('public.claim_due_schedules(integer)'::regprocedure) ilike '%skip locked%', 'claim function uses SKIP LOCKED');
select extensions.dblink_connect_u('sender_concurrency', 'dbname=postgres');
select extensions.dblink_exec('sender_concurrency', 'begin');
select is(
  (select id from extensions.dblink(
    'sender_concurrency',
    $$select id from public.schedules where id = '10000000-0000-4000-8000-000000000006' for update$$
  ) as locked(id uuid)),
  '10000000-0000-4000-8000-000000000006'::uuid,
  'second database session holds the first due schedule lock'
);
select is(
  (select schedule_id from public.claim_due_schedules(1)),
  '10000000-0000-4000-8000-000000000007'::uuid,
  'concurrent claim skips the locked schedule and claims the next one'
);
select extensions.dblink_exec('sender_concurrency', 'commit');
select is(
  (select schedule_id from public.claim_due_schedules(1)),
  '10000000-0000-4000-8000-000000000006'::uuid,
  'a later claim can take the released schedule'
);
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
  now() - interval '1 minute',
  'sender@example.test',
  'https://recurmail.example.test/dashboard?gmail=failed'
);
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000008'), 'paused', 'invalid grant pauses the schedule');
select is((select status from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000006'), 'needs_reconnect', 'connection requires reconnect');
select is((select count(*) from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000006' and status = 'queued'), 1::bigint, 'reconnect email is queued');
select is((select count(*) from public.send_log where status = 'failed' and error_code = 'invalid_grant'), 1::bigint, 'invalid grant attempt is recorded failed');
select public.mark_gmail_reconnect_needed(
  '10000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000006',
  now() - interval '1 minute',
  'sender@example.test',
  'https://recurmail.example.test/dashboard?gmail=failed'
);
select is((select count(*) from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000006'), 1::bigint, 'reconnect outbox queues only one email per connection outage');

insert into public.sender_heartbeats (id, started_at, finished_at, claimed_count, sent_count, failed_count, deferred_count)
values ('30000000-0000-4000-8000-000000000006', now() - interval '1 second', now(), 3, 1, 1, 1);
select is((select count(*) from public.sender_heartbeats where claimed_count = 3 and sent_count = 1 and failed_count = 1 and deferred_count = 1), 1::bigint, 'sender run writes heartbeat counts');

select extensions.dblink_disconnect('sender_concurrency');
delete from auth.users where id = '00000000-0000-4000-8000-000000000006';
delete from public.sender_heartbeats where id = '30000000-0000-4000-8000-000000000006';
select * from finish();
commit;
