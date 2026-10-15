-- Follow-ups to the "Send me a test" rate limit (0008). 0008 is already
-- applied, so both changes land here as a new migration.

-- When a test send learns that the Gmail refresh token is dead (invalid_grant),
-- the connection must stop looking healthy. Same effect as the sender's
-- mark_gmail_reconnect_needed in 0003, in one transaction: the connection is
-- marked needs_reconnect and the user's active schedules are paused. Unlike the
-- sender's path there is no send_log row (no schedule was being sent) and no
-- reconnect email (the user is already reading the message in the editor).
-- Idempotent: an already-marked connection and already-paused schedules are
-- left alone. Only the service role may call it.
create or replace function public.mark_test_send_reconnect_needed(
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.gmail_connections set status = 'needs_reconnect'
    where user_id = p_user_id and status = 'connected';
  update public.schedules set status = 'paused', updated_at = now()
    where user_id = p_user_id and status in ('active', 'sending');
end;
$$;

revoke all on function public.mark_test_send_reconnect_needed(uuid) from public, anon, authenticated;
grant execute on function public.mark_test_send_reconnect_needed(uuid) to service_role;

-- test_sends rows only matter inside the rolling window, but 0008 never removed
-- them. The claim now prunes the caller's rows that have left the window before
-- it counts, under the same per-user advisory lock, so the table holds at most
-- the window's worth of rows per user and the limit behaviour is unchanged.
-- Signature, grants and return shape are identical to 0008.
create or replace function public.claim_test_send(
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
  delete from public.test_sends
   where user_id = p_user_id
     and sent_at < now() - v_window;
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
