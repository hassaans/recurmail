-- Server-side rate limit for "Send me a test" from the schedule editor.
-- One row per test email; the route counts rows per user in a rolling hour.
-- Only the service role reads or writes this table.
create table public.test_sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now()
);

create index test_sends_user_id_sent_at_idx
  on public.test_sends (user_id, sent_at);

alter table public.test_sends enable row level security;

revoke all on public.test_sends from public, anon, authenticated;
grant all on public.test_sends to service_role;
