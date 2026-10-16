create extension if not exists pgtap with schema extensions;

begin;
select plan(55);

-- Two users: A signed up today from reddit, B signed up 100 days ago and is
-- outside a 30 day window. Three browsers: A's, B's and a direct visitor.
-- A fourth browser's rows are 380 days old: inside a two year window only.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000051', 'analytics-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000052', 'analytics-b@example.test', 'authenticated', 'authenticated');

-- grants: the browser and signed-in roles can neither read nor write
select ok((select relrowsecurity from pg_class where oid = 'public.analytics_events'::regclass), 'analytics_events has row level security');
select ok((select relrowsecurity from pg_class where oid = 'public.user_attribution'::regclass), 'user_attribution has row level security');
select ok(not has_table_privilege('anon', 'public.analytics_events', 'SELECT'), 'anon cannot read events');
select ok(not has_table_privilege('anon', 'public.analytics_events', 'INSERT'), 'anon cannot insert events');
select ok(not has_table_privilege('authenticated', 'public.analytics_events', 'SELECT'), 'authenticated cannot read events');
select ok(not has_table_privilege('authenticated', 'public.analytics_events', 'INSERT'), 'authenticated cannot insert events');
select ok(not has_table_privilege('anon', 'public.user_attribution', 'SELECT'), 'anon cannot read attribution');
select ok(not has_table_privilege('authenticated', 'public.user_attribution', 'SELECT'), 'authenticated cannot read attribution');
select ok(not has_table_privilege('authenticated', 'public.user_attribution', 'INSERT'), 'authenticated cannot insert attribution');
select ok(has_table_privilege('service_role', 'public.analytics_events', 'INSERT'), 'service_role can insert events');
select ok(has_table_privilege('service_role', 'public.user_attribution', 'INSERT'), 'service_role can insert attribution');
select ok(not has_function_privilege('anon', 'public.get_analytics_summary(integer)', 'EXECUTE'), 'anon cannot read the summary');
select ok(not has_function_privilege('authenticated', 'public.get_analytics_summary(integer)', 'EXECUTE'), 'authenticated cannot read the summary');
select ok(has_function_privilege('service_role', 'public.get_analytics_summary(integer)', 'EXECUTE'), 'service_role can read the summary');
select ok((select prosecdef from pg_proc where oid = 'public.get_analytics_summary(integer)'::regprocedure), 'the summary runs as its definer');
select is(pg_get_function_result('public.get_analytics_summary(integer)'::regprocedure), 'jsonb', 'the summary returns jsonb');

-- check constraints: nothing but our own shapes gets in
select throws_ok($$insert into public.analytics_events (event) values ('Page View')$$, '23514', null, 'an event name must be lower snake case');
select throws_ok($$insert into public.analytics_events (event) values ('x')$$, '23514', null, 'an event name needs at least two characters');
select throws_ok($$insert into public.analytics_events (event, device) values ('page_view', 'phone')$$, '23514', null, 'a device is mobile, tablet or desktop');
select throws_ok($$insert into public.analytics_events (event, country) values ('page_view', 'usa')$$, '23514', null, 'a country is two upper-case letters');
select throws_ok($$insert into public.analytics_events (event, path) values ('page_view', repeat('a', 513))$$, '23514', null, 'a path is at most 512 characters');
select throws_ok($$insert into public.analytics_events (event, referrer_host) values ('page_view', repeat('a', 256))$$, '23514', null, 'a referrer host is at most 255 characters');
select throws_ok($$insert into public.analytics_events (event, properties) values ('page_view', '[]'::jsonb)$$, '23514', null, 'properties must be an object');
select throws_ok($$insert into public.analytics_events (event, properties) values ('page_view', jsonb_build_object('text', repeat('a', 3000)))$$, '23514', null, 'properties are at most 2 KB');
select throws_ok($$insert into public.analytics_events (event, user_id) values ('page_view', '00000000-0000-4000-8000-000000000099')$$, '23503', null, 'an event cannot name a user that does not exist');
select throws_ok($$insert into public.analytics_events (event, user_agent) values ('page_view', repeat('a', 1025))$$, '23514', null, 'a user agent is at most 1024 characters');
select throws_ok($$insert into public.analytics_events (event, accept_language) values ('page_view', repeat('a', 256))$$, '23514', null, 'an accept-language is at most 255 characters');
select throws_ok($$insert into public.analytics_events (event, user_email) values ('page_view', repeat('a', 321))$$, '23514', null, 'a user email is at most 320 characters');
select throws_ok($$insert into public.analytics_events (event, ip_address) values ('page_view', 'not an address')$$, '22P02', null, 'an address must be an inet');
select throws_ok($$insert into public.user_attribution (user_id, signup_user_agent) values ('00000000-0000-4000-8000-000000000051', repeat('a', 1025))$$, '23514', null, 'a sign-up user agent is at most 1024 characters');
select throws_ok($$insert into public.user_attribution (user_id, first_source) values ('00000000-0000-4000-8000-000000000051', repeat('a', 65))$$, '23514', null, 'a first source is at most 64 characters');
select lives_ok($$insert into public.analytics_events (event, anonymous_id, path, source, device, country, region, city, ip_address, user_agent, accept_language, properties)
  values ('page_view', 'a0000000-0000-4000-8000-000000000001', '/', 'reddit', 'desktop', 'US', 'CA', 'San Francisco', '203.0.113.9', 'Mozilla/5.0', 'en-US,en;q=0.9', '{"depth": 25}'::jsonb)$$, 'a well-formed event is accepted');
select is((select count(*) from public.analytics_events), 1::bigint, 'and stored once');
select is((select is_bot from public.analytics_events limit 1), false, 'an event is not a bot unless flagged');
delete from public.analytics_events;

-- seed a month of activity
insert into public.analytics_events (occurred_at, event, anonymous_id, user_id, path, referrer_host, source) values
  -- browser A: came from reddit, signed up, connected Gmail, created a schedule
  (now() - interval '3 days', 'page_view', 'a0000000-0000-4000-8000-000000000001', null, '/', 'reddit.com', 'reddit'),
  (now() - interval '3 days' + interval '1 minute', 'page_view', 'a0000000-0000-4000-8000-000000000001', null, '/guides/recurring-email-gmail', null, 'reddit'),
  (now() - interval '3 days' + interval '2 minutes', 'signup_started', 'a0000000-0000-4000-8000-000000000001', null, '/', null, 'reddit'),
  (now() - interval '3 days' + interval '3 minutes', 'signup_completed', 'a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000051', null, null, null),
  (now() - interval '3 days' + interval '4 minutes', 'gmail_connected', 'a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000051', null, null, null),
  (now() - interval '3 days' + interval '5 minutes', 'schedule_created', 'a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000051', null, null, null),
  -- browser B: came from google twice, started signing up, no account in this window
  (now() - interval '10 days', 'page_view', 'a0000000-0000-4000-8000-000000000002', null, '/guides/recurring-email-gmail', 'google.com', 'google'),
  (now() - interval '2 days', 'page_view', 'a0000000-0000-4000-8000-000000000002', null, '/', 'google.com', 'google'),
  (now() - interval '2 days' + interval '1 minute', 'signup_started', 'a0000000-0000-4000-8000-000000000002', null, '/', null, 'google'),
  -- browser C: a direct visit to the homepage
  (now() - interval '1 day', 'page_view', 'a0000000-0000-4000-8000-000000000003', null, '/', null, 'direct'),
  -- a cookie-less sign-in recorded against the user only
  (now() - interval '1 day', 'login_completed', null, '00000000-0000-4000-8000-000000000052', null, null, null),
  -- browser D: inside the two year window only
  (now() - interval '380 days', 'page_view', 'a0000000-0000-4000-8000-000000000004', null, '/', 'news.ycombinator.com', 'hackernews');
-- a crawler: stored, but never counted
insert into public.analytics_events (occurred_at, event, anonymous_id, path, referrer_host, source, is_bot, user_agent) values
  (now() - interval '1 hour', 'page_view', 'a0000000-0000-4000-8000-000000000009', '/', 'bing.com', 'bing', true, 'Mozilla/5.0 (compatible; bingbot/2.0)'),
  (now() - interval '1 hour', 'signup_started', 'a0000000-0000-4000-8000-000000000009', '/', null, 'bing', true, 'Mozilla/5.0 (compatible; bingbot/2.0)');
-- the signed-up user's events carry a snapshot of who they were
update public.analytics_events set user_email = 'analytics-a@example.test' where user_id = '00000000-0000-4000-8000-000000000051';
insert into public.user_attribution (user_id, anonymous_id, first_source, first_referrer_host, first_utm_source, first_utm_medium, first_landing_path, first_seen_at, signed_up_at) values
  ('00000000-0000-4000-8000-000000000051', 'a0000000-0000-4000-8000-000000000001', 'reddit', 'reddit.com', 'reddit', 'social', '/', now() - interval '3 days', now() - interval '3 days' + interval '3 minutes'),
  ('00000000-0000-4000-8000-000000000052', 'a0000000-0000-4000-8000-000000000005', 'hackernews', 'news.ycombinator.com', null, null, '/', now() - interval '100 days', now() - interval '100 days');

create temporary table analytics_summaries (label text primary key, result jsonb) on commit drop;
insert into analytics_summaries select '30', public.get_analytics_summary(30);
insert into analytics_summaries select '7', public.get_analytics_summary(7);
insert into analytics_summaries select 'all', public.get_analytics_summary(730);
insert into analytics_summaries select 'clamped', public.get_analytics_summary(9999);

-- summary: shape
select is((select result->>'days' from analytics_summaries where label = '30'), '30', 'the window is echoed');
select is((select result->>'days' from analytics_summaries where label = 'clamped'), '3660', 'the window is clamped to ten years');
select ok((select result ?& array['visitors', 'signups', 'funnel', 'sources', 'landing_paths', 'referrers', 'events'] from analytics_summaries where label = '30'), 'the summary has every section');

-- summary: visitors and funnel over 30 days
select is((select (result->>'visitors')::integer from analytics_summaries where label = '30'), 3, 'three browsers viewed a page in the last 30 days, the crawler not among them');
select is((select count(*) from public.analytics_events where is_bot), 2::bigint, 'the crawler''s events are stored all the same');
select is((select (result->>'signups')::integer from analytics_summaries where label = '30'), 1, 'one user signed up in the last 30 days');
select is((select result->'funnel' from analytics_summaries where label = '30'),
  '{"page_view": 3, "signup_started": 2, "signup_completed": 1, "gmail_connected": 1, "schedule_created": 1}'::jsonb,
  'the funnel counts distinct people at each step');
select is((select (result->'funnel'->>'page_view')::integer from analytics_summaries where label = '7'), 3, 'a 7 day window still sees all three browsers');
select is((select (result->>'visitors')::integer from analytics_summaries where label = 'all'), 4, 'a two year window includes the old browser');
select is((select (result->>'signups')::integer from analytics_summaries where label = 'all'), 2, 'a two year window includes the old sign-up');

-- summary: sources take the first page view per browser and the attribution of each sign-up
select is((select result->'sources' from analytics_summaries where label = '30'),
  '[{"source": "reddit", "visitors": 1, "signups": 1}, {"source": "direct", "visitors": 1, "signups": 0}, {"source": "google", "visitors": 1, "signups": 0}]'::jsonb,
  'sources list visitors and sign-ups, most visitors then most sign-ups first');
select is((select result->'sources' from analytics_summaries where label = 'all'),
  '[{"source": "hackernews", "visitors": 1, "signups": 1}, {"source": "reddit", "visitors": 1, "signups": 1}, {"source": "direct", "visitors": 1, "signups": 0}, {"source": "google", "visitors": 1, "signups": 0}]'::jsonb,
  'a two year window adds the old browser and the old sign-up to their sources');

-- summary: top lists
select is((select result->'landing_paths' from analytics_summaries where label = '30'),
  '[{"path": "/", "visitors": 2}, {"path": "/guides/recurring-email-gmail", "visitors": 1}]'::jsonb,
  'landing pages are the first page each browser saw');
select is((select result->'referrers' from analytics_summaries where label = '30'),
  '[{"host": "google.com", "visitors": 1}, {"host": "reddit.com", "visitors": 1}]'::jsonb,
  'referrers count browsers, not page views');
select is((select result->'events' from analytics_summaries where label = '30'),
  '[{"event": "page_view", "count": 5}, {"event": "signup_started", "count": 2}, {"event": "gmail_connected", "count": 1}, {"event": "login_completed", "count": 1}, {"event": "schedule_created", "count": 1}, {"event": "signup_completed", "count": 1}]'::jsonb,
  'event counts cover every event in the window');

-- deleting a user keeps their events, detached from the account, and removes their attribution
delete from auth.users where id = '00000000-0000-4000-8000-000000000051';
select is((select count(*) from public.analytics_events where anonymous_id = 'a0000000-0000-4000-8000-000000000001'), 6::bigint, 'the deleted user''s events all survive');
select is((select count(*) from public.analytics_events where user_id = '00000000-0000-4000-8000-000000000051'), 0::bigint, 'with the user id cleared');
select is((select count(*) from public.analytics_events where anonymous_id = 'a0000000-0000-4000-8000-000000000001' and user_email = 'analytics-a@example.test'), 3::bigint, 'and the email snapshot kept');
select is((select count(*) from public.user_attribution where user_id = '00000000-0000-4000-8000-000000000051'), 0::bigint, 'the deleted user''s attribution is gone');
select is((select count(*) from public.user_attribution), 1::bigint, 'the other user''s attribution stays');

-- retention: nothing prunes events
select is((select count(*) from cron.job where command ilike '%analytics_events%'), 0::bigint, 'no cron job touches analytics_events');

delete from auth.users where id = '00000000-0000-4000-8000-000000000052';
select * from finish(true);
rollback;
