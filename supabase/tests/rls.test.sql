create extension if not exists pgtap with schema extensions;

begin;
select plan(11);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000001', 'rls-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000002', 'rls-b@example.test', 'authenticated', 'authenticated');

insert into public.gmail_connections (
  user_id, google_email, is_workspace, encrypted_refresh_token, status
) values
  ('00000000-0000-4000-8000-000000000001', 'a@gmail.com', false, 'ciphertext-a', 'connected'),
  ('00000000-0000-4000-8000-000000000002', 'b@gmail.com', false, 'ciphertext-b', 'connected');

insert into public.schedules (
  id, user_id, subject, body_text, "to", rrule, timezone,
  next_send_at, status, source
) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'A schedule', 'A body', array['a@example.test'], 'FREQ=DAILY', 'UTC', now(), 'active', 'web'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'B schedule', 'B body', array['b@example.test'], 'FREQ=DAILY', 'UTC', now(), 'active', 'web');

insert into public.send_log (
  id, schedule_id, user_id, scheduled_for, attempted_at, status
) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', now(), now(), 'sent'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', now(), now(), 'sent');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is((select count(*) from public.schedules), 1::bigint, 'user A sees only their schedules');
select is((select count(*) from public.gmail_connections), 1::bigint, 'user A sees only their Gmail connection');
select is((select count(*) from public.send_log), 1::bigint, 'user A sees only their send history');
select throws_ok(
  $$insert into public.schedules (user_id, subject, body_text, "to", rrule, timezone, next_send_at, status, source)
    values ('00000000-0000-4000-8000-000000000002', 'forbidden', 'body', array['b@example.test'], 'FREQ=DAILY', 'UTC', now(), 'active', 'web')$$,
  '42501', null, 'user A cannot insert a schedule owned by user B'
);
select throws_ok(
  $$insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token)
    values ('00000000-0000-4000-8000-000000000002', 'forbidden@gmail.com', 'ciphertext')$$,
  '42501', null, 'user A cannot insert a Gmail connection owned by user B'
);
select throws_ok(
  $$insert into public.send_log (schedule_id, user_id, scheduled_for, status)
    values ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', now(), 'sent')$$,
  '42501', null, 'user A cannot insert send history owned by user B'
);
update public.schedules set subject = 'overwritten by A'
where id = '10000000-0000-4000-8000-000000000002';
reset role;
select is(
  (select subject from public.schedules where id = '10000000-0000-4000-8000-000000000002'),
  'B schedule', 'user A cannot update user B schedule'
);
set local role service_role;
select is((select count(*) from public.schedules), 2::bigint, 'service role can read schedules for both users');
reset role;

delete from auth.users where id = '00000000-0000-4000-8000-000000000002';
select is((select count(*) from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000002'), 0::bigint, 'deleting a user cascades to Gmail connections');
select is((select count(*) from public.schedules where user_id = '00000000-0000-4000-8000-000000000002'), 0::bigint, 'deleting a user cascades to schedules');
select is((select count(*) from public.send_log where user_id = '00000000-0000-4000-8000-000000000002'), 0::bigint, 'deleting a user cascades to send history');

select * from finish();
rollback;
