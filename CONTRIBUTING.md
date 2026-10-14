# Contributing

## Setup

Use Node.js 20.9 or newer and pnpm 10.18.3. From the repository root, run
`pnpm install`.

## Before opening a pull request

Run all repository checks from the root:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm e2e
```

Keep changes focused and add tests for new behavior. Do not commit `.env` files,
tokens, or other credentials. Describe the change and checks in each pull
request.
