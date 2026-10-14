revoke select, insert, update
  on public.gmail_connections
  from authenticated;
grant select (id, user_id, google_email, is_workspace, status, connected_at)
  on public.gmail_connections
  to authenticated;
grant delete
  on public.gmail_connections
  to authenticated;

revoke insert, update, delete
  on public.send_log
  from authenticated;
