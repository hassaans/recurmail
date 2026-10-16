-- First-party product analytics. The web app's route handlers write here with
-- the service role; nothing is readable by anon or authenticated. Each event
-- keeps the request details the server saw (address, user agent, language,
-- Vercel's geo headers) and, for a signed-in user, who they were at the time.
-- Events are never deleted: an account deletion only detaches the user id.

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  event text not null check (event ~ '^[a-z][a-z0-9_]{1,47}$'),
  -- The browser's random id, kept in local storage and a cookie.
  anonymous_id uuid,
  -- Renewed after 30 minutes idle.
  session_id uuid,
  user_id uuid references auth.users (id) on delete set null,
  -- The address the user signed in with when the event happened, kept as a
  -- snapshot so the event still says who it was after the account is gone.
  user_email text check (char_length(user_email) <= 320),
  path text check (char_length(path) <= 512),
  referrer_host text check (char_length(referrer_host) <= 255),
  -- The channel derived from the campaign tag or the referrer: reddit, x,
  -- google, hackernews, referral, direct and so on.
  source text check (char_length(source) <= 64),
  utm_source text check (char_length(utm_source) <= 255),
  utm_medium text check (char_length(utm_medium) <= 255),
  utm_campaign text check (char_length(utm_campaign) <= 255),
  utm_term text check (char_length(utm_term) <= 255),
  utm_content text check (char_length(utm_content) <= 255),
  device text check (device in ('mobile', 'tablet', 'desktop')),
  -- From Vercel's edge headers.
  country text check (country ~ '^[A-Z]{2}$'),
  region text check (char_length(region) <= 255),
  city text check (char_length(city) <= 255),
  -- The client address (first x-forwarded-for entry), or null when it did not parse.
  ip_address inet,
  user_agent text check (char_length(user_agent) <= 1024),
  accept_language text check (char_length(accept_language) <= 255),
  -- A crawler or script by its user agent; kept, but left out of the summary.
  is_bot boolean not null default false,
  -- Short facts about the action: a frequency, a count bucket, a label.
  properties jsonb not null default '{}'::jsonb
    check (jsonb_typeof(properties) = 'object' and pg_column_size(properties) <= 2048)
);

create index analytics_events_occurred_at_idx on public.analytics_events (occurred_at);
create index analytics_events_event_occurred_at_idx on public.analytics_events (event, occurred_at);
create index analytics_events_anonymous_id_idx on public.analytics_events (anonymous_id);
create index analytics_events_user_id_idx on public.analytics_events (user_id);

-- Where each user came from the first time their browser saw the site,
-- copied from the browser's first-touch cookie when they sign up.
create table public.user_attribution (
  user_id uuid primary key references auth.users (id) on delete cascade,
  anonymous_id uuid,
  user_email text check (char_length(user_email) <= 320),
  signup_ip inet,
  signup_user_agent text check (char_length(signup_user_agent) <= 1024),
  first_source text not null default 'direct' check (char_length(first_source) <= 64),
  first_referrer_host text check (char_length(first_referrer_host) <= 255),
  first_utm_source text check (char_length(first_utm_source) <= 255),
  first_utm_medium text check (char_length(first_utm_medium) <= 255),
  first_utm_campaign text check (char_length(first_utm_campaign) <= 255),
  first_utm_term text check (char_length(first_utm_term) <= 255),
  first_utm_content text check (char_length(first_utm_content) <= 255),
  first_landing_path text check (char_length(first_landing_path) <= 512),
  first_seen_at timestamptz,
  signed_up_at timestamptz not null default now()
);

create index user_attribution_signed_up_at_idx on public.user_attribution (signed_up_at);

alter table public.analytics_events enable row level security;
alter table public.user_attribution enable row level security;
revoke all on public.analytics_events, public.user_attribution from public, anon, authenticated;
grant all on public.analytics_events, public.user_attribution to service_role;

-- The admin page's acquisition summary over the trailing p_days (1 to 3660).
-- A visitor is a browser with a page view. Funnel steps count distinct
-- people, identified by the browser where known and otherwise by the user,
-- so a server-recorded sign-up joins the browser that viewed the page.
-- Visitors by source take the browser's first page view in the window;
-- sign-ups by source take the attribution row of users who signed up in
-- the window. Events flagged as bots are left out. Every list is capped.
create or replace function public.get_analytics_summary(p_days integer default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3660))) as since
  ),
  events as (
    select e.event, e.anonymous_id, e.user_id, e.path, e.referrer_host, e.source, e.occurred_at
    from public.analytics_events e, bounds
    where e.occurred_at >= bounds.since and not e.is_bot
  ),
  people as (
    select event, coalesce(anonymous_id::text, user_id::text) as person
    from events
    where anonymous_id is not null or user_id is not null
  ),
  first_views as (
    select distinct on (anonymous_id) anonymous_id, coalesce(source, 'direct') as source, path
    from events
    where event = 'page_view' and anonymous_id is not null
    order by anonymous_id, occurred_at, path
  ),
  signups as (
    select a.user_id, a.first_source
    from public.user_attribution a, bounds
    where a.signed_up_at >= bounds.since
  ),
  by_source as (
    select source, count(*)::integer as visitors, 0 as signups from first_views group by source
    union all
    select first_source, 0, count(*)::integer from signups group by first_source
  ),
  sources as (
    select source, sum(visitors)::integer as visitors, sum(signups)::integer as signups
    from by_source
    group by source
    order by sum(visitors) desc, sum(signups) desc, source
    limit 25
  ),
  landing_paths as (
    select path, count(*)::integer as visitors
    from first_views
    where path is not null
    group by path
    order by count(*) desc, path
    limit 10
  ),
  referrers as (
    select referrer_host as host, count(distinct anonymous_id)::integer as visitors
    from events
    where event = 'page_view' and referrer_host is not null and anonymous_id is not null
    group by referrer_host
    order by count(distinct anonymous_id) desc, referrer_host
    limit 10
  ),
  event_counts as (
    select event, count(*)::integer as count
    from events
    group by event
    order by count(*) desc, event
    limit 50
  )
  select jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 3660)),
    'visitors', (select count(*)::integer from first_views),
    'signups', (select count(*)::integer from signups),
    'funnel', jsonb_build_object(
      'page_view', (select count(distinct person)::integer from people where event = 'page_view'),
      'signup_started', (select count(distinct person)::integer from people where event = 'signup_started'),
      'signup_completed', (select count(distinct person)::integer from people where event = 'signup_completed'),
      'gmail_connected', (select count(distinct person)::integer from people where event = 'gmail_connected'),
      'schedule_created', (select count(distinct person)::integer from people where event = 'schedule_created')
    ),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'visitors', visitors, 'signups', signups) order by visitors desc, signups desc, source) from sources), '[]'::jsonb),
    'landing_paths', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'visitors', visitors) order by visitors desc, path) from landing_paths), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(jsonb_build_object('host', host, 'visitors', visitors) order by visitors desc, host) from referrers), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', event, 'count', count) order by count desc, event) from event_counts), '[]'::jsonb)
  );
$$;

revoke all on function public.get_analytics_summary(integer) from public, anon, authenticated;
grant execute on function public.get_analytics_summary(integer) to service_role;
