# RecurMail

RecurMail sends recurring emails from your own Gmail account on a schedule you
set. It runs at [recurmail.com](https://recurmail.com).

## Repository

```text
apps/web/     Next.js web app
packages/core shared TypeScript library (schedules, MIME)
supabase/     database migrations, tests and the send-due Edge Function
e2e/          Playwright browser tests
docs/         project documentation
```

## Quick start

Requires Node.js 20.9+ and pnpm 10.18.3.

```sh
pnpm install
pnpm --filter @recurmail/web dev
```

The home page runs without configuration. To sign in and send mail, follow
[setup](docs/setup.md).

## Documentation

- [Setup](docs/setup.md): Google, Supabase, environment variables and deployment
- [Architecture](docs/architecture.md): sign-in, Gmail credentials and sending
- [Testing](docs/testing.md): checks to run and what CI covers
- [Monitoring](docs/monitoring.md): Sentry, cron monitor and admin metrics
- [Schedule API](docs/openapi.yaml): OpenAPI 3.1 description of `/api/schedules`
- [Contributing](.github/CONTRIBUTING.md) and [security](.github/SECURITY.md)

## License

[GNU AGPL v3.0](LICENSE)
