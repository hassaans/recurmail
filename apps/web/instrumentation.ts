import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export function onRequestError(
  ...args: Parameters<typeof Sentry.captureRequestError>
) {
  Sentry.captureRequestError(...args);
}
