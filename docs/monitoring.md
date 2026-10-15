# Monitoring

## Sentry setup

Set `SENTRY_DSN` in the web and `send-due` environments. The browser SDK receives the public project DSN through the web build. A DSN cannot write to the Sentry API. When the variable is empty, capture stays off and the app still runs.

Set `SENTRY_CRON_MONITOR_SLUG=send-due-every-minute` in `send-due`. Each invocation reports its start and completion to Sentry. It also sends a `send_failure_rate_last_hour` gauge from `send_log` rows marked `sent` or `failed` in the trailing hour. The sender heartbeat stores that rate and its failed and attempted counts. A failed query leaves those fields null.

## Cron monitor

The pg_cron jobs require only these Vault secrets:

- `project_url`: the Supabase project URL.
- `sender_cron_secret`: the shared secret checked by the `send-due` function.

The jobs send these values as `Content-Type` and
`x-recurmail-cron-secret` headers. They do not store or send a Supabase API key.

Create this monitor in the Sentry project that receives the web DSN before deploying with Sentry enabled.

- Slug is `send-due-every-minute`.
- Schedule runs every minute in UTC.
- Check-in margin is 5 minutes.
- Maximum runtime is 5 minutes.
- One missed check-in marks the monitor as failed.
- Notify the owner when the monitor is missed or failed.

The slug must match `SENTRY_CRON_MONITOR_SLUG`.

## Send failure alert

Create a metric alert in the same Sentry project.

- Metric is `send_failure_rate_last_hour`.
- Use the latest value.
- Trigger above `0.10`, or 10 percent.
- Evaluate over 5 minutes and trigger once per incident.
- Resolve at or below `0.10`.
- Notify the owner.

Each value is already a trailing one-hour ratio. The alert window checks recent measurements. The denominator includes sends marked `sent` or `failed`; it excludes `skipped` and `deferred` rows.

## Admin metrics

The admin page is limited to addresses in the server-side `ADMIN_EMAILS` comma-separated list. Signed-out visitors and other signed-in users get a 404. The page calls a service-only SQL function and renders counts only.

“Kept sending for 30 days” counts distinct users with an active schedule created at least 30 days ago and at least one send marked `sent` in the last 7 days.
