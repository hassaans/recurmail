import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs/config";

const appDirectory = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN?.trim() || "" },
  transpilePackages: ["@recurmail/core"],
  outputFileTracingRoot: resolve(appDirectory, "../.."),
  // Callback query strings contain OAuth codes; handler errors use safe events.
  logging: {
    incomingRequests: {
      ignore: [/^\/auth\/callback(?:\?|$)/, /^\/api\/gmail\/callback(?:\?|$)/],
    },
  },
};

export default withSentryConfig(nextConfig, { silent: true, telemetry: false });
