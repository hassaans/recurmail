create extension if not exists pgtap with schema extensions;

begin;
select plan(11);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000009', 'recovery@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token, status)
values ('00000000-0000-4000-8000-000000000009', 'recovery@example.test', 'ciphertext', 'connected');
insert into public.schedules (
  id, user_id, subject, body_text, "to", rrule, timezone, next_send_at, status, updated_at
) values
  ('10000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000009', 'stale', 'body', array['stale@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '20 minutes', 'sending', now() - interval '20 minutes'),
  ('10000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000009', 'fresh', 'body', array['fresh@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '2 minutes', 'sending', now() - interval '2 minutes'),
  ('10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000009', 'active', 'body', array['active@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '20 minutes', 'active', now() - interval '20 minutes');

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
select ok(position('for update' in lower(pg_get_functiondef('public.reclaim_stale_sending(interval)'::regprocedure))) > 0, 'recovery locks selected rows');
select ok(position('skip locked' in lower(pg_get_functiondef('public.reclaim_stale_sending(interval)'::regprocedure))) > 0, 'recovery skips rows claimed by another run');

delete from auth.users where id = '00000000-0000-4000-8000-000000000009';
select * from finish(true);
commit;
