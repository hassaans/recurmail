create extension if not exists pgtap with schema extensions;

begin;
select plan(36);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000031', 'multi@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000032', 'multi-other@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (id, user_id, google_email, is_workspace, encrypted_refresh_token, status) values
  ('40000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'first@gmail.com', false, 'ciphertext-1', 'connected'),
  ('40000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000031', 'second@company.test', true, 'ciphertext-2', 'connected'),
  ('40000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000032', 'other@gmail.com', false, 'ciphertext-3', 'connected');

select is((select count(*) from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000031'), 2::bigint, 'a user can connect two Gmail accounts');
select throws_ok(
  $$insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token)
    values ('00000000-0000-4000-8000-000000000031', 'First@Gmail.com', 'ciphertext-dup')$$,
  '23505', null, 'the same account cannot be connected twice, whatever its case'
);
insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token)
select '00000000-0000-4000-8000-000000000031', 'extra' || n || '@example.test', 'ciphertext-extra'
from generate_series(1, 8) as n;
select is((select count(*) from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000031'), 10::bigint, 'ten accounts fit under the cap');
select throws_ok(
  $$insert into public.gmail_connections (user_id, google_email, encrypted_refresh_token)
    values ('00000000-0000-4000-8000-000000000031', 'eleventh@example.test', 'ciphertext-11')$$,
  '23514', null, 'the eleventh account is rejected server-side'
);
delete from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000031' and google_email like 'extra%';

insert into public.schedules (
  id, user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status
) values
  ('10000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000031', 'from first', 'body', array['one@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '2 minutes', 'active'),
  ('10000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000032', 'from second', 'body', array['two@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('10000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000032', 'from second, paused', 'body', array['three@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'paused'),
  ('10000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000032', '40000000-0000-4000-8000-000000000033', 'other user', 'body', array['four@example.test'], 'FREQ=DAILY', 'UTC', now() + interval '1 hour', 'active');
select throws_ok(
  $$insert into public.schedules (user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status)
    values ('00000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000033', 'foreign sender', 'body', array['x@example.test'], 'FREQ=DAILY', 'UTC', now(), 'active')$$,
  '23503', null, 'a schedule cannot send from another user''s connection'
);
select throws_ok(
  $$insert into public.schedules (user_id, subject, body_text, "to", rrule, timezone, next_send_at, status)
    values ('00000000-0000-4000-8000-000000000031', 'no sender', 'body', array['x@example.test'], 'FREQ=DAILY', 'UTC', now(), 'active')$$,
  '23514', null, 'an active schedule needs a sender'
);
select lives_ok(
  $$insert into public.schedules (id, user_id, subject, body_text, "to", rrule, timezone, next_send_at, status)
    values ('10000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000031', 'waiting for a sender', 'body', array['x@example.test'], 'FREQ=DAILY', 'UTC', now(), 'paused')$$,
  'a paused schedule can wait for a sender'
);
select throws_ok(
  $$update public.schedules set status = 'active' where id = '10000000-0000-4000-8000-000000000034'$$,
  '23514', null, 'a schedule without a sender cannot be resumed'
);

select is(
  (select gmail_connection_id from public.claim_due_schedules(1)),
  '40000000-0000-4000-8000-000000000031'::uuid,
  'claim returns the connection the earliest schedule sends from'
);
select is(
  (select google_email from public.claim_due_schedules(1)),
  'second@company.test',
  'claim takes the sender email from the schedule''s own connection'
);
select is((select count(*) from public.claim_due_schedules(10)), 0::bigint, 'paused rows and schedules that are not due are not claimed');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000035'), 'active', 'the other user''s schedule is untouched by the claims');

select public.mark_gmail_reconnect_needed(
  '10000000-0000-4000-8000-000000000032',
  '00000000-0000-4000-8000-000000000031',
  '40000000-0000-4000-8000-000000000032',
  now() - interval '1 minute',
  'second@company.test',
  'https://recurmail.example.test/dashboard?gmail=failed'
);
select is((select status from public.gmail_connections where id = '40000000-0000-4000-8000-000000000032'), 'needs_reconnect', 'only the failing connection needs reconnect');
select is((select status from public.gmail_connections where id = '40000000-0000-4000-8000-000000000031'), 'connected', 'the other connection stays connected');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000032'), 'paused', 'the failing connection''s schedule is paused');
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000031'), 'sending', 'the other connection''s claimed schedule is untouched');
select is((select recipient from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000031'), 'second@company.test', 'the reconnect email goes to the failing account');
select is((select count(*) from public.send_log where schedule_id = '10000000-0000-4000-8000-000000000032' and error_code = 'invalid_grant'), 1::bigint, 'the invalid grant is logged against the schedule');

update public.schedules set updated_at = now() - interval '20 minutes' where id = '10000000-0000-4000-8000-000000000031';
select is(
  (select gmail_connection_id from public.reclaim_stale_sending(interval '10 minutes')),
  '40000000-0000-4000-8000-000000000031'::uuid,
  'stale recovery returns the schedule''s connection'
);

delete from public.gmail_connections where id = '40000000-0000-4000-8000-000000000031';
select is((select status from public.schedules where id = '10000000-0000-4000-8000-000000000031'), 'paused', 'removing a connection pauses the schedules that sent from it');
select is((select gmail_connection_id from public.schedules where id = '10000000-0000-4000-8000-000000000031'), null, 'the removed connection is cleared from its schedules');
select is((select count(*) from public.schedules where user_id = '00000000-0000-4000-8000-000000000031'), 4::bigint, 'removing a connection keeps the schedules');

delete from auth.users where id = '00000000-0000-4000-8000-000000000032';
select is((select count(*) from public.schedules where user_id = '00000000-0000-4000-8000-000000000032'), 0::bigint, 'deleting a user with active schedules still cascades');

select ok(has_function_privilege('service_role', 'public.mark_gmail_reconnect_needed(uuid, uuid, uuid, timestamptz, text, text)', 'EXECUTE'), 'service_role can mark a connection for reconnect');
select ok(not has_function_privilege('authenticated', 'public.mark_gmail_reconnect_needed(uuid, uuid, uuid, timestamptz, text, text)', 'EXECUTE'), 'authenticated cannot mark a connection for reconnect');
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'mark_gmail_reconnect_needed'), 1::bigint, 'only the per-connection reconnect function remains');

-- The Google account id keys a connection. Rows from before the column
-- existed have none, and any number of them may coexist; once set, an id is
-- unique per user, while another user may hold the same id.
select has_column('public', 'gmail_connections', 'google_sub', 'connections carry the Google account id');
select col_is_null('public', 'gmail_connections', 'google_sub', 'the Google account id is nullable for rows from before it was stored');
select lives_ok($$
  insert into public.gmail_connections (id, user_id, google_email, is_workspace, encrypted_refresh_token, status, google_sub) values
    ('40000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000031', 'third@gmail.com', false, 'ciphertext-4', 'connected', 'google-sub-third'),
    ('40000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000031', 'fourth@gmail.com', false, 'ciphertext-5', 'connected', null),
    ('40000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-000000000031', 'fifth@gmail.com', false, 'ciphertext-6', 'connected', null)
$$, 'rows without a Google account id do not collide with each other');
select throws_ok($$
  insert into public.gmail_connections (user_id, google_email, is_workspace, encrypted_refresh_token, status, google_sub) values
    ('00000000-0000-4000-8000-000000000031', 'renamed-third@gmail.com', false, 'ciphertext-7', 'connected', 'google-sub-third')
$$, '23505', null, 'one row per Google account id per user');
select throws_ok($$
  update public.gmail_connections set google_sub = 'google-sub-third' where id = '40000000-0000-4000-8000-000000000035'
$$, '23505', null, 'an existing row cannot take another row''s Google account id');
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000033', 'multi-third@example.test', 'authenticated', 'authenticated');
select lives_ok($$
  insert into public.gmail_connections (user_id, google_email, is_workspace, encrypted_refresh_token, status, google_sub) values
    ('00000000-0000-4000-8000-000000000033', 'third-elsewhere@gmail.com', false, 'ciphertext-8', 'connected', 'google-sub-third')
$$, 'another user may hold the same Google account id');
select throws_ok($$
  insert into public.gmail_connections (user_id, google_email, is_workspace, encrypted_refresh_token, status, google_sub) values
    ('00000000-0000-4000-8000-000000000031', 'blank-sub@gmail.com', false, 'ciphertext-9', 'connected', '')
$$, '23514', null, 'a blank Google account id is refused');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000031', true);
set local role authenticated;
select is((select count(id) from public.gmail_connections), 4::bigint, 'the user reads the ids of their remaining connections');
select is((select count(*) from public.schedules where gmail_connection_id = '40000000-0000-4000-8000-000000000032'), 2::bigint, 'the user reads which connection each schedule sends from');
select throws_ok($$select google_sub from public.gmail_connections$$, '42501', null, 'the Google account id is hidden from the user, like the token');
reset role;

select * from finish(true);
rollback;
