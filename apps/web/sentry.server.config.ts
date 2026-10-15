import * as Sentry from "@sentry/nextjs";
import { beforeSend } from "./lib/sentry";

Sentry.init({
  dsn: process.env.SENTRY_DSN?.trim() || undefined,
  beforeSend,
  sendDefaultPii: false,
});
