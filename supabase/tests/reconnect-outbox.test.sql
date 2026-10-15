create extension if not exists pgtap with schema extensions;

begin;
select plan(13);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000019', 'outbox@example.test', 'authenticated', 'authenticated');
insert into public.reconnect_email_outbox (id, user_id, recipient, reconnect_url, status, created_at, claimed_at) values
  ('20000000-0000-4000-8000-000000000019', '00000000-0000-4000-8000-000000000019', 'queued@example.test', 'https://example.test/reconnect/1', 'queued', now() - interval '3 minutes', null),
  ('20000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000019', 'queued2@example.test', 'https://example.test/reconnect/2', 'queued', now() - interval '2 minutes', null),
  ('20000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000019', 'sending@example.test', 'https://example.test/reconnect/3', 'sending', now() - interval '1 minute', now()),
  ('20000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000019', 'sent@example.test', 'https://example.test/reconnect/4', 'sent', now(), null),
  ('20000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000019', 'failed@example.test', 'https://example.test/reconnect/5', 'failed', now(), null);

select is((select id from public.claim_reconnect_email_outbox(1)), '20000000-0000-4000-8000-000000000019'::uuid, 'first call claims the oldest queued notice');
select is((select status from public.reconnect_email_outbox where id = '20000000-0000-4000-8000-000000000019'), 'sending', 'claimed row is marked sending');
select is((select attempts from public.reconnect_email_outbox where id = '20000000-0000-4000-8000-000000000019'), 1, 'claim increments attempts');
select ok((select claimed_at is not null from public.reconnect_email_outbox where id = '20000000-0000-4000-8000-000000000019'), 'claim timestamp is stored');
select is((select id from public.claim_reconnect_email_outbox(1)), '20000000-0000-4000-8000-000000000020'::uuid, 'second concurrent-safe claim gets another queued notice');
select is((select count(*) from public.claim_reconnect_email_outbox(20)), 0::bigint, 'claimed, sending, sent, and failed rows are not returned twice');
select is((select count(*) from public.reconnect_email_outbox where status = 'sending'), 3::bigint, 'both claims and the fresh sending fixture remain sending');
select ok(position('skip locked' in lower(pg_get_functiondef('public.claim_reconnect_email_outbox(integer)'::regprocedure))) > 0, 'claim function uses SKIP LOCKED');
select ok((select prosecdef from pg_proc where oid = 'public.claim_reconnect_email_outbox(integer)'::regprocedure), 'claim function is security definer');
select ok(not has_function_privilege('anon', 'public.claim_reconnect_email_outbox(integer)', 'EXECUTE'), 'anon cannot claim notices');
select ok(not has_function_privilege('authenticated', 'public.claim_reconnect_email_outbox(integer)', 'EXECUTE'), 'authenticated cannot claim notices');
select ok(has_function_privilege('service_role', 'public.claim_reconnect_email_outbox(integer)', 'EXECUTE'), 'service_role can claim notices');
select is(pg_get_function_result('public.claim_reconnect_email_outbox(integer)'::regprocedure), 'TABLE(id uuid, recipient text, reconnect_url text, attempts integer)', 'claim returns the email delivery fields and attempt count');

delete from auth.users where id = '00000000-0000-4000-8000-000000000019';
select * from finish(true);
commit;
