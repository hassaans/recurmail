import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs/config";

const appDirectory = dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN?.trim() || "" },
  transpilePackages: ["@recurmail/core"],
  // Serve metadata (icons, manifest, social cards) in <head> for every client,
  // not streamed into <body>: iOS home-screen icons and link previews read <head>.
  htmlLimitedBots: /.*/,
  outputFileTracingRoot: resolve(appDirectory, "../.."),
  // Callback query strings contain OAuth codes; handler errors use safe events.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No site may frame RecurMail (clickjacking on the dashboard).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Cross-origin requests get the origin only, never paths or queries.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
  logging: {
    incomingRequests: {
      ignore: [/^\/auth\/callback(?:\?|$)/, /^\/api\/gmail\/callback(?:\?|$)/],
    },
  },
};

export default withSentryConfig(nextConfig, { silent: true, telemetry: false });
