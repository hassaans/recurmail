-- Server-side rate limit for "Send me a test" from the schedule editor.
-- One row per test email; the route claims a row per user in a rolling hour.
-- Only the service role reads or writes this table or calls the function.
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

-- Reserve one test send for a user, or refuse because the rolling window is
-- full. Claims for the same user run one at a time behind a transaction-scoped
-- advisory lock, so concurrent requests can never exceed the limit and exactly
-- as many as the window has room for get through. A refusal reports the oldest
-- send still inside the window; the window frees up at that time plus the
-- window length. The route deletes its reserved row again when the email does
-- not go out, so a failed send does not use up the quota.
create function public.claim_test_send(
  p_user_id uuid,
  p_limit integer,
  p_window_seconds integer
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_window interval := make_interval(secs => p_window_seconds);
  v_count integer;
  v_oldest timestamptz;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('test_sends'), hashtext(p_user_id::text));
  select count(*), min(sent_at)
    into v_count, v_oldest
    from public.test_sends
   where user_id = p_user_id
     and sent_at >= now() - v_window;
  if v_count >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'oldest_sent_at', to_char(v_oldest at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  end if;
  insert into public.test_sends (user_id) values (p_user_id) returning id into v_id;
  return jsonb_build_object('allowed', true, 'id', v_id);
end;
$$;

revoke all on function public.claim_test_send(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_test_send(uuid, integer, integer) to service_role;
