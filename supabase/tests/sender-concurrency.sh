#!/usr/bin/env bash
set -euo pipefail

container=supabase_db_recurmail
user_id=00000000-0000-4000-8000-000000000009
first_id=10000000-0000-4000-8000-000000000009
second_id=10000000-0000-4000-8000-000000000010
connection_id=40000000-0000-4000-8000-000000000009
first_notice=20000000-0000-4000-8000-000000000010
second_notice=20000000-0000-4000-8000-000000000011
work_dir=$(mktemp -d)
first_output="$work_dir/first"
second_output="$work_dir/second"
first_error="$work_dir/first.err"
second_error="$work_dir/second.err"
first_pid=
second_pid=

cleanup() {
  if [[ -n "$first_pid" ]]; then wait "$first_pid" 2>/dev/null || true; fi
  if [[ -n "$second_pid" ]]; then wait "$second_pid" 2>/dev/null || true; fi
  docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "delete from auth.users where id = '$user_id'" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, email, aud, role)
values ('$user_id', 'sender-concurrency@example.test', 'authenticated', 'authenticated');
insert into public.gmail_connections (id, user_id, google_email, encrypted_refresh_token, status)
values ('$connection_id', '$user_id', 'sender-concurrency@example.test', 'ciphertext', 'connected');
insert into public.schedules (
  id, user_id, gmail_connection_id, subject, body_text, "to", rrule, timezone, next_send_at, status
) values
  ('$first_id', '$user_id', '$connection_id', 'first', 'body', array['first@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active'),
  ('$second_id', '$user_id', '$connection_id', 'second', 'body', array['second@example.test'], 'FREQ=DAILY', 'UTC', now() - interval '1 minute', 'active');
insert into public.reconnect_email_outbox (id, user_id, recipient, reconnect_url)
values
  ('$first_notice', '$user_id', 'first@example.test', 'https://example.test/reconnect/1'),
  ('$second_notice', '$user_id', 'second@example.test', 'https://example.test/reconnect/2');
SQL

claim_sql="begin; set role service_role; select schedule_id from public.claim_due_schedules(1); select pg_sleep(5); commit;"
docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$claim_sql" >"$first_output" 2>"$first_error" &
first_pid=$!
for _ in $(seq 1 100); do
  if [[ -s "$first_output" ]]; then break; fi
  if ! kill -0 "$first_pid" 2>/dev/null; then cat "$first_error" >&2; exit 1; fi
  sleep 0.05
done
if [[ ! -s "$first_output" ]]; then echo 'first claim did not return while holding its transaction lock' >&2; exit 1; fi

docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$claim_sql" >"$second_output" 2>"$second_error" &
second_pid=$!
wait "$first_pid" || { cat "$first_error" >&2; exit 1; }
wait "$second_pid" || { cat "$second_error" >&2; exit 1; }

first_claim=$(awk 'NF { print; exit }' "$first_output")
second_claim=$(awk 'NF { print; exit }' "$second_output")
if [[ -z "$first_claim" || -z "$second_claim" || "$first_claim" == "$second_claim" ]]; then
  printf 'concurrent claims were not unique: first=%s second=%s\n' "$first_claim" "$second_claim" >&2
  exit 1
fi
printf 'Concurrent claims returned distinct schedule ids: %s and %s\n' "$first_claim" "$second_claim"

first_output="$work_dir/notice-first"
second_output="$work_dir/notice-second"
first_error="$work_dir/notice-first.err"
second_error="$work_dir/notice-second.err"
notice_claim_sql="begin; set role service_role; select id from public.claim_reconnect_email_outbox(1); select pg_sleep(5); commit;"
docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$notice_claim_sql" >"$first_output" 2>"$first_error" &
first_pid=$!
for _ in $(seq 1 100); do
  if [[ -s "$first_output" ]]; then break; fi
  if ! kill -0 "$first_pid" 2>/dev/null; then cat "$first_error" >&2; exit 1; fi
  sleep 0.05
done
if [[ ! -s "$first_output" ]]; then echo 'first notice claim did not return while holding its transaction lock' >&2; exit 1; fi
docker exec -i -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$notice_claim_sql" >"$second_output" 2>"$second_error" &
second_pid=$!
wait "$first_pid" || { cat "$first_error" >&2; exit 1; }
first_pid=
wait "$second_pid" || { cat "$second_error" >&2; exit 1; }
second_pid=
first_claim=$(awk 'NF { print; exit }' "$first_output")
second_claim=$(awk 'NF { print; exit }' "$second_output")
if [[ -z "$first_claim" || -z "$second_claim" || "$first_claim" == "$second_claim" ]]; then
  printf 'concurrent outbox claims were not unique: first=%s second=%s\n' "$first_claim" "$second_claim" >&2
  exit 1
fi
printf 'Concurrent outbox claims returned distinct notice ids: %s and %s\n' "$first_claim" "$second_claim"
