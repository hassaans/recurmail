create table public.gmail_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  google_email text not null,
  is_workspace boolean not null default false,
  encrypted_refresh_token text not null,
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect', 'disconnected')),
  connected_at timestamptz not null default now(),
  unique (user_id)
);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subject text not null,
  body_text text not null,
  body_html text,
  "to" text[] not null default '{}',
  cc text[] not null default '{}',
  bcc text[] not null default '{}',
  rrule text not null,
  timezone text not null,
  next_send_at timestamptz not null,
  status text not null default 'paused'
    check (status in ('active', 'paused', 'sending')),
  source text not null default 'web'
    check (source in ('web', 'api', 'cli', 'mcp')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index schedules_status_next_send_at_idx
  on public.schedules (status, next_send_at);

create table public.send_log (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  scheduled_for timestamptz not null,
  attempted_at timestamptz not null default now(),
  status text not null check (status in ('sent', 'failed', 'skipped')),
  gmail_message_id text,
  error_code text,
  foreign key (schedule_id, user_id)
    references public.schedules (id, user_id) on delete cascade
);

create index send_log_schedule_id_idx on public.send_log (schedule_id);

alter table public.gmail_connections enable row level security;
alter table public.schedules enable row level security;
alter table public.send_log enable row level security;

create policy "Users can manage their Gmail connections"
  on public.gmail_connections
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Users can manage their schedules"
  on public.schedules
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Users can manage their send history"
  on public.send_log
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update, delete
  on public.gmail_connections, public.schedules, public.send_log
  to authenticated;
grant all
  on public.gmail_connections, public.schedules, public.send_log
  to service_role;
