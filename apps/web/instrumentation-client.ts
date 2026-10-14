import * as Sentry from "@sentry/nextjs";
import { beforeSend } from "./lib/sentry";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined,
  beforeSend,
  sendDefaultPii: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
