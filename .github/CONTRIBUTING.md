# Contributing

1. Install Node.js 20.9+ and pnpm 10.18.3, then run `pnpm install`.
2. Keep each pull request to one focused change, and add tests for new behavior.
3. Before you open a pull request, run `pnpm typecheck`, `pnpm lint`,
   `pnpm test` and `pnpm e2e`. See [testing](../docs/testing.md).
4. Never commit `.env` files, tokens or other credentials.

In the pull request, describe the change and the checks you ran.
