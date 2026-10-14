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
cp .env.example .env.local
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

The home page runs without environment variables. Later stories will add the
integrations that need them. Set local values only in ignored env files. Never
commit credentials.

## Quality checks

Pull requests targeting `main` run typecheck, lint, unit tests, the Playwright
home smoke test, and a Gitleaks secret scan.

## License

This project is licensed under the GNU Affero General Public License v3.0. See
`LICENSE`.
