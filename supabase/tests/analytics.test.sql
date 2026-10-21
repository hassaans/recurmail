create extension if not exists pgtap with schema extensions;

begin;
select plan(74);

-- Three users: A signed up 3 days ago from reddit, B signed up 100 days ago
-- and is outside a 30 day window, E signed up yesterday on a direct visit
-- from a browser first brought by reddit 60 days ago. Browsers: A's, B's
-- (no account in the window), a direct visitor C, E's, and F, where the
-- long-standing user B created a schedule without signing up again. A sixth
-- browser D's rows are 380 days old: inside a two year window only.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-000000000051', 'analytics-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000052', 'analytics-b@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-000000000053', 'analytics-e@example.test', 'authenticated', 'authenticated');

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
select ok(not has_function_privilege('anon', 'public.record_client_event(jsonb, integer, integer, integer)', 'EXECUTE'), 'anon cannot record a browser event');
select ok(not has_function_privilege('authenticated', 'public.record_client_event(jsonb, integer, integer, integer)', 'EXECUTE'), 'authenticated cannot record a browser event');
select ok(has_function_privilege('service_role', 'public.record_client_event(jsonb, integer, integer, integer)', 'EXECUTE'), 'service_role can record a browser event');

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

-- record_client_event: each address gets a budget of events and of browsers per window
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000001", "path": "/", "source": "reddit", "device": "mobile", "ip_address": "198.51.100.7", "user_agent": "Mozilla/5.0", "is_bot": false, "properties": {"depth": 25}}'::jsonb, 600, 3, 10), true, 'a browser event within budget is stored');
select is((select count(*) from public.analytics_events where ip_address = '198.51.100.7' and anonymous_id = 'b0000000-0000-4000-8000-000000000001' and path = '/' and source = 'reddit' and device = 'mobile' and properties = '{"depth": 25}'::jsonb), 1::bigint, 'with every field it was given');
select is(public.record_client_event('{"event": "cta_click", "anonymous_id": "b0000000-0000-4000-8000-000000000001", "ip_address": "198.51.100.7"}'::jsonb, 600, 3, 10), true, 'a second event from the address is stored');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000002", "ip_address": "198.51.100.7"}'::jsonb, 600, 3, 10), true, 'a third event reaches the budget');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000001", "ip_address": "198.51.100.7"}'::jsonb, 600, 3, 10), false, 'a fourth event in the window is refused');
select is((select count(*) from public.analytics_events where ip_address = '198.51.100.7'), 3::bigint, 'and not stored');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000001", "ip_address": "198.51.100.8"}'::jsonb, 600, 3, 10), true, 'another address has its own budget');
update public.analytics_events set occurred_at = now() - interval '11 minutes' where ip_address = '198.51.100.7';
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000001", "ip_address": "198.51.100.7"}'::jsonb, 600, 3, 10), true, 'events older than the window free the budget');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000011", "ip_address": "203.0.113.20"}'::jsonb, 600, 100, 2), true, 'a first browser from an address is stored');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000012", "ip_address": "203.0.113.20"}'::jsonb, 600, 100, 2), true, 'a second browser reaches the browser budget');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000013", "ip_address": "203.0.113.20"}'::jsonb, 600, 100, 2), false, 'a third new browser from the address is refused');
select is(public.record_client_event('{"event": "scroll_depth", "anonymous_id": "b0000000-0000-4000-8000-000000000011", "ip_address": "203.0.113.20"}'::jsonb, 600, 100, 2), true, 'a browser already seen from the address is still stored');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000021"}'::jsonb, 600, 1, 10), true, 'without an address the browser id carries the budget');
select is(public.record_client_event('{"event": "page_view", "anonymous_id": "b0000000-0000-4000-8000-000000000021"}'::jsonb, 600, 1, 10), false, 'and is refused once it is spent');
select is(public.record_client_event('{"event": "page_view"}'::jsonb, 600, 100, 10), false, 'an event with neither an address nor a browser id is refused');
select throws_ok($$select public.record_client_event('{"event": "Page View", "anonymous_id": "b0000000-0000-4000-8000-000000000031", "ip_address": "192.0.2.1"}'::jsonb, 600, 100, 10)$$, '23514', null, 'a browser event still meets the table''s checks');
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
  -- browser E: brought by reddit 60 days ago, back directly yesterday to sign up
  (now() - interval '60 days', 'page_view', 'a0000000-0000-4000-8000-000000000005', null, '/guides/recurring-email-gmail', 'reddit.com', 'reddit'),
  (now() - interval '1 day', 'page_view', 'a0000000-0000-4000-8000-000000000005', null, '/', null, 'direct'),
  (now() - interval '1 day' + interval '1 minute', 'signup_started', 'a0000000-0000-4000-8000-000000000005', null, '/', null, 'direct'),
  (now() - interval '1 day' + interval '2 minutes', 'signup_completed', 'a0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000053', null, null, null),
  -- browser F: user B, signed up long ago, viewed the site and added a schedule
  (now() - interval '2 days', 'page_view', 'a0000000-0000-4000-8000-000000000006', null, '/', null, 'direct'),
  (now() - interval '2 days' + interval '1 minute', 'schedule_created', 'a0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000052', null, null, null),
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
  ('00000000-0000-4000-8000-000000000052', 'a0000000-0000-4000-8000-000000000007', 'hackernews', 'news.ycombinator.com', null, null, '/', now() - interval '100 days', now() - interval '100 days'),
  ('00000000-0000-4000-8000-000000000053', 'a0000000-0000-4000-8000-000000000005', 'reddit', 'reddit.com', null, null, '/guides/recurring-email-gmail', now() - interval '60 days', now() - interval '1 day' + interval '2 minutes');

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
select is((select (result->>'visitors')::integer from analytics_summaries where label = '30'), 5, 'five browsers viewed a page in the last 30 days, the crawler not among them');
select is((select count(*) from public.analytics_events where is_bot), 2::bigint, 'the crawler''s events are stored all the same');
select is((select (result->>'signups')::integer from analytics_summaries where label = '30'), 2, 'two users signed up in the last 30 days');
select is((select result->'funnel' from analytics_summaries where label = '30'),
  '{"page_view": 5, "signup_started": 3, "signup_completed": 2, "gmail_connected": 1, "schedule_created": 1}'::jsonb,
  'each funnel step counts only people who reached the step before it');
select is((select (result->'funnel'->>'page_view')::integer from analytics_summaries where label = '7'), 5, 'a 7 day window still sees all five browsers');
select is((select (result->>'visitors')::integer from analytics_summaries where label = 'all'), 6, 'a two year window includes the old browser');
select is((select (result->>'signups')::integer from analytics_summaries where label = 'all'), 3, 'a two year window includes the old sign-up');

-- summary: sources credit each visitor, and their sign-up, to their browser's first page view ever
select is((select result->'sources' from analytics_summaries where label = '30'),
  '[{"source": "reddit", "visitors": 2, "signups": 2}, {"source": "direct", "visitors": 2, "signups": 0}, {"source": "google", "visitors": 1, "signups": 0}]'::jsonb,
  'a reddit visitor who came back directly to sign up counts as a reddit visitor and sign-up');
select is((select result->'sources' from analytics_summaries where label = 'all'),
  '[{"source": "reddit", "visitors": 2, "signups": 2}, {"source": "direct", "visitors": 2, "signups": 0}, {"source": "google", "visitors": 1, "signups": 0}, {"source": "hackernews", "visitors": 1, "signups": 0}]'::jsonb,
  'a sign-up from a browser never seen is left out of sources, so no source has more sign-ups than visitors');

-- summary: top lists
select is((select result->'landing_paths' from analytics_summaries where label = '30'),
  '[{"path": "/", "visitors": 4}, {"path": "/guides/recurring-email-gmail", "visitors": 1}]'::jsonb,
  'landing pages are the first page each browser saw');
select is((select result->'referrers' from analytics_summaries where label = '30'),
  '[{"host": "google.com", "visitors": 1}, {"host": "reddit.com", "visitors": 1}]'::jsonb,
  'referrers count browsers, not page views');
select is((select result->'events' from analytics_summaries where label = '30'),
  '[{"event": "page_view", "count": 7}, {"event": "signup_started", "count": 3}, {"event": "schedule_created", "count": 2}, {"event": "signup_completed", "count": 2}, {"event": "gmail_connected", "count": 1}, {"event": "login_completed", "count": 1}]'::jsonb,
  'event counts cover every event in the window');

-- deleting a user keeps their events, detached from the account, and removes their attribution
delete from auth.users where id = '00000000-0000-4000-8000-000000000051';
select is((select count(*) from public.analytics_events where anonymous_id = 'a0000000-0000-4000-8000-000000000001'), 6::bigint, 'the deleted user''s events all survive');
select is((select count(*) from public.analytics_events where user_id = '00000000-0000-4000-8000-000000000051'), 0::bigint, 'with the user id cleared');
select is((select count(*) from public.analytics_events where anonymous_id = 'a0000000-0000-4000-8000-000000000001' and user_email = 'analytics-a@example.test'), 3::bigint, 'and the email snapshot kept');
select is((select count(*) from public.user_attribution where user_id = '00000000-0000-4000-8000-000000000051'), 0::bigint, 'the deleted user''s attribution is gone');
select is((select count(*) from public.user_attribution), 2::bigint, 'the other users'' attribution stays');

-- retention: nothing prunes events
select is((select count(*) from cron.job where command ilike '%analytics_events%'), 0::bigint, 'no cron job touches analytics_events');

delete from auth.users where id in ('00000000-0000-4000-8000-000000000052', '00000000-0000-4000-8000-000000000053');
select * from finish(true);
rollback;
