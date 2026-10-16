# Testing

## Everyday checks

Run these from the repository root:

```sh
pnpm typecheck
pnpm lint      # Biome
pnpm test      # Vitest for apps/web and packages/core
pnpm e2e       # Playwright
```

Unit tests replace Supabase Auth, Google and storage with fakes. They cover the
HTTP handlers, encryption, owner isolation and provider failures.

Browser tests start the web app on port 3100 and a fake Google and Supabase
service on port 3101. Each test uses fresh users and synthetic credentials. The
tests check full flows, including sign-in, connecting Gmail, schedules, test
sends and disconnecting. They also check that no tokens appear in HTML, cookies
or server logs. To run a second copy alongside, set `RECURMAIL_E2E_WEB_PORT` and
`RECURMAIL_E2E_FAKE_PORT`. Install the browser once with
`pnpm exec playwright install chromium`.

The fake service accepts only loopback addresses, through
`RECURMAIL_TEST_OAUTH_ORIGIN`, and production ignores that setting.

## Database and sender

These tests need Docker and the Supabase CLI.

```sh
supabase start
supabase test db supabase/tests/rls.test.sql   # repeat for each *.test.sql
bash supabase/tests/sender-concurrency.sh
deno test --no-check --node-modules-dir=none --lock=supabase/functions/deno.lock \
  --allow-env --allow-read --allow-net --allow-run \
  --import-map=supabase/functions/import_map.json supabase/functions/send-due
```

## CI

Every pull request to `main` runs:

- Typecheck, lint, unit tests, a production build, a check that the browser
  bundle has no Supabase project address, and the browser tests
- Every pgTAP file, the concurrent-claim test and the Deno tests
- A Gitleaks secret scan
- A Safari Reader check on the home page, run when web code changes

When you add a pgTAP file, add it to `.github/workflows/ci.yml`.
