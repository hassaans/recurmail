# RecurMail

RecurMail sends scheduled messages from a user's own Gmail account.

## Repository layout

```text
apps/
  web/       Next.js App Router web app
  cli/       reserved for a later release; not created yet
  mcp/       reserved for a later release; not created yet
  ios/       reserved for a later release; not created yet
packages/
  core/      shared TypeScript library
supabase/
  migrations/ database migrations
  functions/  Supabase Edge Functions
e2e/         Playwright browser tests
```

## Requirements

- Node.js 20.9 or newer
- pnpm 10.18.3
- Playwright's Chromium browser for end-to-end tests

## Getting started

```sh
pnpm install
cp .env.example apps/web/.env.local
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

The home page and signed-out dashboard run without environment variables. To
sign in or connect Gmail, fill in `apps/web/.env.local` and run
`pnpm --filter @recurmail/web dev`. Keep credentials in ignored env files or
deployment secrets.

## Google and Supabase setup

Apply the migrations in `supabase/migrations` to your Supabase project, including
`0002_harden_grants.sql`. Enable the Google provider in Supabase Auth with your
Google OAuth client ID and secret. Sign-in requests `openid email profile` only.
Configure Supabase's site URL to match `APP_URL` and allow
`APP_URL/auth/callback**` in its redirect URL list. The callback includes a state
query parameter.

Register two redirect URIs on the Google OAuth web client. Use your Supabase
project's `/auth/v1/callback` URL for sign-in and
`APP_URL/api/gmail/callback` for the separate Gmail connection. Enable the Gmail
API and configure the consent screen for
`https://www.googleapis.com/auth/gmail.send`. During Google's testing stage, add
your test accounts to the consent screen's test-user list.

Set these variables in the web app's environment.

| Variable | Value |
| --- | --- |
| `APP_URL` | The web app's origin, such as `http://localhost:3000` locally or its HTTPS origin in production. Use this same host in your browser. |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The project's anonymous API key. |
| `SUPABASE_SERVICE_ROLE_KEY` | The server's service-role key, used for connection writes, credential reads and schedule pausing. |
| `GOOGLE_CLIENT_ID` | The Google OAuth web client ID. |
| `GOOGLE_CLIENT_SECRET` | That client's secret. |
| `TOKEN_ENCRYPTION_KEY` | Standard base64 encoding of exactly 32 random bytes, held only in server secrets. |

Generate the encryption key once with
`node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'`
and save it in your secret store. Replacing the key without migrating stored
credentials makes existing connections unreadable and invalidates sessions.

Open `/dashboard` to sign in, then choose Connect Gmail. Connect the same Google
account used for sign-in. RecurMail passes its email as `login_hint` and records
that email as the sender. Google treats this parameter as a hint, so the user must
choose that account on the consent screen. The connection requests exactly
`gmail.send`, offline access and consent, without incremental scope expansion.
It does not request inbox access or make a profile lookup with the Gmail token.
Both sign-in and the separate Gmail connection use PKCE S256. The Gmail verifier
stays in the encrypted, HttpOnly state cookie, bound to the signed-in user, until
the server exchanges the code. Only its challenge goes to the consent page.

Refresh tokens are encrypted with AES-256-GCM and bound to the Supabase user ID.
Only the service role can read or write the token column. Dashboard reads use
the user's verified Supabase session and explicitly select the nonsecret columns
allowed by migration 0002. Gmail credentials never appear in the session cookie,
page output or API responses. The encrypted, HttpOnly session cookie holds only
Supabase session credentials; provider tokens returned during sign-in are discarded.

Failed auth, connection, storage and revocation operations produce ERROR-level
logs with a fixed event name. Logs omit exception messages, provider responses,
emails, OAuth codes and credentials. Next's development request logger also
excludes the two OAuth callback routes so their query strings stay out of logs.

Disconnect pauses the user's schedules, revokes the Google refresh token, then
deletes the connection. If revocation fails, the encrypted token remains for a
retry. Successful reconnecting does not resume paused schedules. The account type
comes from the signed-in email domain, with `gmail.com` and `googlemail.com` counted
as personal Gmail and other domains counted as Workspace.

## Quality checks

Pull requests targeting `main` run typecheck, lint, unit tests, the Playwright
browser tests, and a Gitleaks secret scan.

`pnpm test` includes the web app's Vitest tests and the shared library tests. The
web tests inject fake Auth, Google token and revocation services, and persistence.
They exercise the HTTP handlers through successful connection and disconnect,
encrypted storage, owner isolation and permission denial, including provider and
storage failures.

`pnpm e2e` starts a local fake OAuth/Supabase service and the web app on ports
3101 and 3100 with synthetic credentials and fresh users for each test. Chromium
signs in, connects Gmail through the fake consent callback, and disconnects.
The test checks PKCE, the encrypted database row, token revocation, row deletion
and schedule pausing, while confirming other users' data stays untouched. It also
checks that HTML, cookies and server logs contain no tokens. The suite covers
permission denial, reconnect UI and session refresh too.

Playwright sets `RECURMAIL_TEST_OAUTH_ORIGIN` to the fake server's loopback origin.
The app rejects non-loopback endpoints and ignores this setting in production.
Session verification still goes through Supabase Auth. These tests use local
fakes; verifying live Google OAuth, Supabase persistence or email delivery needs
configured services and a dedicated Google test account.

The native adapters follow [Google's web OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Supabase's PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

## License

This project is licensed under the GNU Affero General Public License v3.0. See
`LICENSE`.
