create extension if not exists pgtap with schema extensions;

begin;
select plan(38);

-- Two users. A has two accounts: the personal one exercises the test-send
-- limit and the dead-token path, the work one proves that the reconnect
-- marking stays on the account that failed. B proves that pruning and the
-- marking stay scoped to one user.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000031', 'test-send-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000032', 'test-send-b@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (id, user_id, google_email, encrypted_refresh_token, status) values
  ('30000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'test-send-a@example.test', 'ciphertext-a', 'connected'),
  ('30000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000031', 'test-send-a@company.test', 'ciphertext-a-work', 'connected'),
  ('30000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000032', 'test-send-b@example.test', 'ciphertext-b', 'connected');
insert into public.schedules (
  id, user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status, updated_at
) values
  ('10000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000031', 'active', 'body', array['a@example.test'], 'FREQ=DAILY', 'UTC', now() + interval '1 hour', 'active', now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000031', 'sending', 'body', array['a@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'sending', now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000031', 'paused', 'body', array['a@example.test'], 'FREQ=DAILY', 'UTC', now() + interval '1 hour', 'paused', now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000032', '30000000-0000-4000-8000-000000000033', 'other active', 'body', array['b@example.test'], 'FREQ=DAILY', 'UTC', now() + interval '1 hour', 'active', now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000032', 'work active', 'body', array['a@example.test'], 'FREQ=DAILY', 'UTC', now() + interval '1 hour', 'active', now() - interval '1 day');
-- A has two sends that left the hour window and three still inside it; B has one stale send.
insert into public.test_sends (user_id, sent_at) values
  ('00000000-0000-4000-8000-000000000031', now() - interval '2 hours'),
  ('00000000-0000-4000-8000-000000000031', now() - interval '61 minutes'),
  ('00000000-0000-4000-8000-000000000031', now() - interval '50 minutes'),
  ('00000000-0000-4000-8000-000000000031', now() - interval '30 minutes'),
  ('00000000-0000-4000-8000-000000000031', now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000032', now() - interval '3 hours');

create temporary table test_send_claims (label text primary key, result jsonb) on commit drop;

-- claim_test_send: shape and grants unchanged by 0009
select is(pg_get_function_result('public.claim_test_send(uuid, integer, integer)'::regprocedure), 'jsonb', 'claim_test_send still returns jsonb');
select ok(not (select prosecdef from pg_proc where oid = 'public.claim_test_send(uuid, integer, integer)'::regprocedure), 'claim_test_send is still security invoker');
select ok(not has_function_privilege('anon', 'public.claim_test_send(uuid, integer, integer)', 'EXECUTE'), 'anon cannot claim a test send');
select ok(not has_function_privilege('authenticated', 'public.claim_test_send(uuid, integer, integer)', 'EXECUTE'), 'authenticated cannot claim a test send');
select ok(has_function_privilege('service_role', 'public.claim_test_send(uuid, integer, integer)', 'EXECUTE'), 'service_role can claim a test send');

-- claim_test_send: rows older than the window are pruned for the caller only
insert into test_send_claims select 'a-first', public.claim_test_send('00000000-0000-4000-8000-000000000031', 5, 3600);
select is((select result->>'allowed' from test_send_claims where label = 'a-first'), 'true', 'three sends in the window leave room for a fourth');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000031' and sent_at < now() - interval '1 hour'), 0::bigint, 'the claim removed the caller''s sends that left the window');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000031'), 4::bigint, 'the caller keeps the three sends inside the window plus the new one');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000032'), 1::bigint, 'another user''s stale send is left alone');
select ok((select (result->>'id')::uuid in (select id from public.test_sends where user_id = '00000000-0000-4000-8000-000000000031') from test_send_claims where label = 'a-first'), 'the claim returns the id of the inserted row');

-- claim_test_send: the limit behaviour is unchanged
insert into test_send_claims select 'a-second', public.claim_test_send('00000000-0000-4000-8000-000000000031', 5, 3600);
select is((select result->>'allowed' from test_send_claims where label = 'a-second'), 'true', 'the fifth send in the window is allowed');
insert into test_send_claims select 'a-third', public.claim_test_send('00000000-0000-4000-8000-000000000031', 5, 3600);
select is((select result->>'allowed' from test_send_claims where label = 'a-third'), 'false', 'the sixth send in the window is refused');
select matches((select result->>'oldest_sent_at' from test_send_claims where label = 'a-third'), '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$', 'a refusal reports the oldest send as ISO 8601 UTC');
select ok((select (result->>'oldest_sent_at')::timestamptz between now() - interval '50 minutes 1 second' and now() - interval '49 minutes 59 seconds' from test_send_claims where label = 'a-third'), 'the oldest send is the 50-minute-old one, never a pruned one');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000031'), 5::bigint, 'a refusal inserts nothing');
insert into test_send_claims select 'b-first', public.claim_test_send('00000000-0000-4000-8000-000000000032', 5, 3600);
select is((select result->>'allowed' from test_send_claims where label = 'b-first'), 'true', 'the other user''s stale send does not count against them');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000032'), 1::bigint, 'the other user''s stale send is pruned by their own claim');
select is((select count(*) from public.test_sends where user_id = '00000000-0000-4000-8000-000000000032' and sent_at < now() - interval '1 hour'), 0::bigint, 'only the fresh row remains for the other user');

-- mark_test_send_reconnect_needed: shape and grants. 0007 replaced the
-- per-user version from 0009 with one that takes the connection; 0010 removes
-- the per-user version where 0009 ran after 0007.
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'mark_test_send_reconnect_needed'), 1::bigint, 'exactly one mark_test_send_reconnect_needed remains');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'mark_test_send_reconnect_needed' and p.pronargs = 1), 'the per-user version from 0009 is gone');
select is(pg_get_function_result('public.mark_test_send_reconnect_needed(uuid, uuid)'::regprocedure), 'void', 'mark_test_send_reconnect_needed returns void');
select ok((select prosecdef from pg_proc where oid = 'public.mark_test_send_reconnect_needed(uuid, uuid)'::regprocedure), 'mark_test_send_reconnect_needed is security definer');
select ok(not has_function_privilege('anon', 'public.mark_test_send_reconnect_needed(uuid, uuid)', 'EXECUTE'), 'anon cannot mark a reconnect');
select ok(not has_function_privilege('authenticated', 'public.mark_test_send_reconnect_needed(uuid, uuid)', 'EXECUTE'), 'authenticated cannot mark a reconnect');
select ok(has_function_privilege('service_role', 'public.mark_test_send_reconnect_needed(uuid, uuid)', 'EXECUTE'), 'service_role can mark a reconnect');

-- mark_test_send_reconnect_needed: the account that failed and the schedules sending from it, nothing else
select lives_ok($$select public.mark_test_send_reconnect_needed('00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000031')$$, 'marking a reconnect succeeds');
select is((select status from public.gmail_connections where id = '30000000-0000-4000-8000-000000000031'), 'needs_reconnect', 'the account that failed is marked needs_reconnect');
select is((select status from public.gmail_connections where id = '30000000-0000-4000-8000-000000000032'), 'connected', 'the user''s other account stays connected');
select is((select array_agg(status order by id) from public.schedules where user_id = '00000000-0000-4000-8000-000000000031'), array['paused', 'paused', 'paused', 'active'], 'active and sending schedules from that account are paused, the paused one stays paused, the other account''s schedule stays active');
select is((select count(*) from public.schedules where user_id = '00000000-0000-4000-8000-000000000031' and updated_at > now() - interval '1 minute'), 2::bigint, 'only the schedules that changed get a new updated_at');
select is((select count(*) from public.send_log where user_id = '00000000-0000-4000-8000-000000000031'), 0::bigint, 'no send_log row is written');
select is((select count(*) from public.reconnect_email_outbox where user_id = '00000000-0000-4000-8000-000000000031'), 0::bigint, 'no reconnect email is queued');
select is((select status from public.gmail_connections where user_id = '00000000-0000-4000-8000-000000000032') || '/' || (select status from public.schedules where id = '10000000-0000-4000-8000-000000000034'), 'connected/active', 'another user''s connection and schedule are untouched');
select lives_ok($$select public.mark_test_send_reconnect_needed('00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000031')$$, 'marking a reconnect twice is harmless');
select lives_ok($$select public.mark_test_send_reconnect_needed('00000000-0000-4000-8000-000000000032', '30000000-0000-4000-8000-000000000032')$$, 'marking an account the caller does not own is accepted');
select is((select status from public.gmail_connections where id = '30000000-0000-4000-8000-000000000032') || '/' || (select status from public.schedules where id = '10000000-0000-4000-8000-000000000035'), 'connected/active', 'but changes nothing, because the ownership check is inside the function');
select lives_ok($$select public.mark_test_send_reconnect_needed('00000000-0000-4000-8000-000000000031', '30000000-0000-4000-8000-000000000099')$$, 'an unknown connection id is harmless');
select is((select count(*) from public.schedules where user_id = '00000000-0000-4000-8000-000000000031' and status = 'active'), 1::bigint, 'the work schedule is still the only active one');

delete from auth.users where id in ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000032');
select * from finish(true);
rollback;
