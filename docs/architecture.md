# Architecture

## Components

- **Web app** (`apps/web`): Next.js on Vercel. It handles sign-in, Gmail
  connections, the schedule API and test sends.
- **Database** (`supabase/migrations`): Postgres with row-level security. Users
  read their own rows. Only the `service_role` key can read Gmail credentials.
- **Sender** (`supabase/functions/send-due`): a Deno Edge Function. pg_cron
  calls it every minute through pg_net.
- **Core** (`packages/core`): recurrence rules, MIME building and daily-limit
  checks, shared by the web app and the sender.

## Sign-in

The web app runs Google's authorization-code flow with PKCE and a one-time
nonce. It sends Google the SHA-256 digest of the nonce. It then sends Google's
ID token and the raw nonce to Supabase Auth to create the session. Sign-in
requests `openid email profile`, and provider tokens are discarded.

The session cookie is encrypted and HttpOnly. It holds only the Supabase
session.

## Gmail connections

A user can connect up to 10 Gmail accounts. Each schedule names the account it
sends from. The connection requests `openid email gmail.send` with offline
access, PKCE and `prompt=consent`. The account comes from the ID token in that
response: its `sub` claim stays fixed, and its email address can change. It is
never assumed to be the account used to sign in. RecurMail has no access to the
inbox.

Refresh tokens are encrypted with AES-256-GCM and bound to the user ID.
Credentials never appear in cookies, pages, API responses or logs.

Disconnecting pauses that account's schedules, revokes the refresh token, then
deletes the connection. If the revoke fails, the encrypted token stays so the
disconnect can be retried. Reconnecting does not resume paused schedules.

## Sending

Each run of `send-due`:

1. Checks the `x-recurmail-cron-secret` header.
2. Claims due schedules in the database, which keeps concurrent runs from
   sending the same message twice.
3. Refreshes the account's access token and sends through the Gmail API.
4. Writes a row to `send_log` and moves the schedule to its next occurrence.

If Google rejects a refresh token, the connection is marked `needs_reconnect`,
its schedules are paused, and a reconnect email is queued. Later runs send that
email through Resend.

Test sends from the editor go straight from the web app to Gmail. They are rate
limited.

## Logging

Failures are logged at ERROR level with a fixed event name. Logs leave out
exception messages, provider responses, email addresses, OAuth codes and
credentials. Sentry reports are scrubbed the same way. See
[monitoring](monitoring.md).
