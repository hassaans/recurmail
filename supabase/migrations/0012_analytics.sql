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
create index analytics_events_ip_address_occurred_at_idx on public.analytics_events (ip_address, occurred_at);

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

-- Stores one event a browser sent to /api/events, unless the address it came
-- from has used up its budget for the rolling window: at most p_max_events
-- events, and at most p_max_browsers different browser ids, so a script
-- cannot grow the table or invent visitors at will. Requests without an
-- address are budgeted by their browser id. Claims for one address run one
-- at a time behind a transaction-scoped advisory lock, so concurrent
-- requests cannot overshoot. Returns whether the event was stored.
create function public.record_client_event(
  p_event jsonb,
  p_window_seconds integer,
  p_max_events integer,
  p_max_browsers integer
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_row public.analytics_events := jsonb_populate_record(null::public.analytics_events, p_event);
  v_since timestamptz := now() - make_interval(secs => p_window_seconds);
  v_events integer;
  v_browsers integer;
  v_known boolean;
begin
  if v_row.ip_address is not null then
    perform pg_advisory_xact_lock(hashtext('analytics_events'), hashtext(host(v_row.ip_address)));
    select count(*), count(distinct anonymous_id), coalesce(bool_or(anonymous_id = v_row.anonymous_id), false)
      into v_events, v_browsers, v_known
      from public.analytics_events
     where ip_address = v_row.ip_address
       and occurred_at >= v_since;
    if v_events >= p_max_events then
      return false;
    end if;
    if v_row.anonymous_id is not null and not v_known and v_browsers >= p_max_browsers then
      return false;
    end if;
  elsif v_row.anonymous_id is not null then
    perform pg_advisory_xact_lock(hashtext('analytics_events'), hashtext(v_row.anonymous_id::text));
    select count(*)
      into v_events
      from public.analytics_events
     where anonymous_id = v_row.anonymous_id
       and occurred_at >= v_since;
    if v_events >= p_max_events then
      return false;
    end if;
  else
    return false;
  end if;
  insert into public.analytics_events (
    event, anonymous_id, session_id, user_id, user_email, path, referrer_host, source,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content, device,
    country, region, city, ip_address, user_agent, accept_language, is_bot, properties
  ) values (
    v_row.event, v_row.anonymous_id, v_row.session_id, v_row.user_id, v_row.user_email, v_row.path,
    v_row.referrer_host, v_row.source, v_row.utm_source, v_row.utm_medium, v_row.utm_campaign,
    v_row.utm_term, v_row.utm_content, v_row.device, v_row.country, v_row.region, v_row.city,
    v_row.ip_address, v_row.user_agent, v_row.accept_language, coalesce(v_row.is_bot, false),
    coalesce(v_row.properties, '{}'::jsonb)
  );
  return true;
end;
$$;

revoke all on function public.record_client_event(jsonb, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.record_client_event(jsonb, integer, integer, integer) to service_role;

-- The admin page's acquisition summary over the trailing p_days (1 to 3660).
-- A visitor is a browser with a page view. Funnel steps count distinct
-- people, identified by the browser where known and otherwise by the user,
-- so a server-recorded sign-up joins the browser that viewed the page. Each
-- step counts only people who reached the step before it, earlier in the
-- window, so no step can exceed the one above it. Sources follow one cohort,
-- the window's visitors: each is credited to the source of their browser's
-- first page view ever, and a sign-up counts for the source when that
-- browser signed up in the window. Landing pages are the first page each
-- browser saw in the window. Events flagged as bots are left out. Every
-- list is capped.
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
    select event, coalesce(anonymous_id::text, user_id::text) as person, occurred_at
    from events
    where anonymous_id is not null or user_id is not null
  ),
  step_page_view as (
    select person, min(occurred_at) as reached_at
    from people
    where event = 'page_view'
    group by person
  ),
  step_signup_started as (
    select p.person, min(p.occurred_at) as reached_at
    from people p
    join step_page_view s on s.person = p.person and p.occurred_at >= s.reached_at
    where p.event = 'signup_started'
    group by p.person
  ),
  step_signup_completed as (
    select p.person, min(p.occurred_at) as reached_at
    from people p
    join step_signup_started s on s.person = p.person and p.occurred_at >= s.reached_at
    where p.event = 'signup_completed'
    group by p.person
  ),
  step_gmail_connected as (
    select p.person, min(p.occurred_at) as reached_at
    from people p
    join step_signup_completed s on s.person = p.person and p.occurred_at >= s.reached_at
    where p.event = 'gmail_connected'
    group by p.person
  ),
  step_schedule_created as (
    select p.person, min(p.occurred_at) as reached_at
    from people p
    join step_gmail_connected s on s.person = p.person and p.occurred_at >= s.reached_at
    where p.event = 'schedule_created'
    group by p.person
  ),
  first_views as (
    select distinct on (anonymous_id) anonymous_id, path
    from events
    where event = 'page_view' and anonymous_id is not null
    order by anonymous_id, occurred_at, path
  ),
  first_touches as (
    select distinct on (e.anonymous_id) e.anonymous_id, coalesce(e.source, 'direct') as source
    from public.analytics_events e
    join first_views v on v.anonymous_id = e.anonymous_id
    where e.event = 'page_view' and not e.is_bot
    order by e.anonymous_id, e.occurred_at, e.path
  ),
  signups as (
    select a.user_id, a.anonymous_id
    from public.user_attribution a, bounds
    where a.signed_up_at >= bounds.since
  ),
  touch_counts as (
    select t.source,
      count(*)::integer as visitors,
      count(*) filter (where exists (select 1 from signups s where s.anonymous_id = t.anonymous_id))::integer as signups
    from first_touches t
    group by t.source
  ),
  sources as (
    select source, visitors, signups
    from touch_counts
    order by visitors desc, signups desc, source
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
      'page_view', (select count(*)::integer from step_page_view),
      'signup_started', (select count(*)::integer from step_signup_started),
      'signup_completed', (select count(*)::integer from step_signup_completed),
      'gmail_connected', (select count(*)::integer from step_gmail_connected),
      'schedule_created', (select count(*)::integer from step_schedule_created)
    ),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'visitors', visitors, 'signups', signups) order by visitors desc, signups desc, source) from sources), '[]'::jsonb),
    'landing_paths', coalesce((select jsonb_agg(jsonb_build_object('path', path, 'visitors', visitors) order by visitors desc, path) from landing_paths), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(jsonb_build_object('host', host, 'visitors', visitors) order by visitors desc, host) from referrers), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', event, 'count', count) order by count desc, event) from event_counts), '[]'::jsonb)
  );
$$;

revoke all on function public.get_analytics_summary(integer) from public, anon, authenticated;
grant execute on function public.get_analytics_summary(integer) to service_role;
