# Setup

## Google Cloud

1. Create an OAuth web client.
2. Add two authorized redirect URIs: `${APP_URL}/auth/callback` for sign-in and
   `${APP_URL}/api/gmail/callback` for connecting Gmail.
3. Enable the Gmail API.
4. Add `https://www.googleapis.com/auth/gmail.send` to the consent screen.
   Until the app is verified, list your test accounts as test users.

Sign-in requests `openid email profile`. Connecting Gmail requests
`openid email gmail.send` with offline access.

## Supabase

1. Apply the migrations: `supabase db push`.
2. Turn on the Google provider in Auth, using the same client ID and secret.
   Set the Auth site URL to `APP_URL`.
3. Add two Vault secrets for pg_cron: `project_url` (the project URL) and
   `sender_cron_secret` (the same value as `SENDER_CRON_SECRET`).
4. Set the function secrets listed below, then deploy:
   `supabase functions deploy send-due`. `supabase/config.toml` turns off JWT
   verification, because the function checks the cron secret itself.

pg_cron calls `send-due` every minute. See [monitoring](monitoring.md) for the
cron jobs and Sentry.

## Environment variables

Copy `apps/web/.env.example` to `apps/web/.env.local` for the web app. For the
function, copy `supabase/functions/.env.example` to `supabase/functions/.env`.
In production, set these as Vercel and Supabase secrets. Never commit filled-in
env files.

| Variable | Web | Function | Value |
| --- | :-: | :-: | --- |
| `APP_URL` | ✓ | ✓ | Public origin, such as `http://localhost:3000` |
| `SUPABASE_URL` | ✓ | | Project URL. Supabase provides it to functions. |
| `SUPABASE_PUBLISHABLE_KEY` | ✓ | | Publishable API key |
| `SUPABASE_SECRET_KEY` | ✓ | fallback | Secret API key. Functions read the provided `SUPABASE_SECRET_KEYS` first. |
| `GOOGLE_CLIENT_ID` | ✓ | ✓ | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✓ | ✓ | OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | ✓ | ✓ | Base64 of 32 random bytes, the same in both places |
| `ADMIN_EMAILS` | ✓ | | Comma-separated addresses that can open `/admin` |
| `SENTRY_DSN` | ✓ | ✓ | Optional. Leave it empty to turn Sentry off. |
| `SENDER_CRON_SECRET` | | ✓ | Shared secret that pg_cron sends |
| `RESEND_API_KEY` | | ✓ | Sends the email that asks a user to reconnect |
| `RECONNECT_EMAIL_FROM` | | ✓ | Sender for that email, such as `RecurMail <support@example.com>` |
| `SENTRY_CRON_MONITOR_SLUG` | | ✓ | `send-due-every-minute` |

Generate the encryption key once:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'
```

If you change the key, the stored Gmail connections can no longer be read, and
everyone is signed out.

## Deployment

Vercel builds `apps/web` from `main`. Apply database migrations and deploy the
function with the Supabase CLI before you merge code that depends on them.
