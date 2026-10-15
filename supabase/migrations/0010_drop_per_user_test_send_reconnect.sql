-- 0007 replaced mark_test_send_reconnect_needed(p_user_id) with a version
-- that takes the connection as well, so a dead token on one account no longer
-- marks every account and pauses every schedule. Live applies 0007 after 0009
-- and 0007 drops the per-user version itself. A fresh database applies 0009
-- after 0007 and 0009 creates the per-user version again, so it is dropped
-- here, after both. Either order ends with only the two-argument function.
drop function if exists public.mark_test_send_reconnect_needed(uuid);
