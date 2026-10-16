import { scrubSentryEvent } from "@recurmail/core";
import * as Sentry from "@sentry/deno";

export function beforeSend<T extends object>(event: T): T {
  return scrubSentryEvent(event);
}

export function initSentry(dsn: string | undefined): void {
  Sentry.init({
    dsn: dsn?.trim() || undefined,
    beforeSend,
    sendDefaultPii: false,
  });
}

export function captureError(error: unknown, dsn: string | undefined): void {
  if (dsn?.trim()) Sentry.captureException(error);
}

// Sent with every in-progress check-in so Sentry creates or updates the
// monitor itself. Matches docs/monitoring.md.
export const SEND_DUE_MONITOR_CONFIG = {
  schedule: { type: "crontab", value: "* * * * *" },
  timezone: "UTC",
  checkinMargin: 5,
  maxRuntime: 5,
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
} as const;

export function startCronCheckIn(
  dsn: string | undefined,
  monitorSlug: string | undefined,
  captureCheckIn: typeof Sentry.captureCheckIn = Sentry.captureCheckIn,
): { monitorSlug: string; checkInId: string } | null {
  const slug = monitorSlug?.trim();
  if (!slug || !dsn?.trim()) return null;
  const checkInId = captureCheckIn(
    { monitorSlug: slug, status: "in_progress" },
    SEND_DUE_MONITOR_CONFIG,
  );
  return typeof checkInId === "string"
    ? { monitorSlug: slug, checkInId }
    : null;
}

export function finishCronCheckIn(
  checkIn: { monitorSlug: string; checkInId: string } | null,
  status: "ok" | "error",
): void {
  if (!checkIn) return;
  Sentry.captureCheckIn({
    monitorSlug: checkIn.monitorSlug,
    checkInId: checkIn.checkInId,
    status,
  });
}

// The edge runtime can stop the function once the response is sent, so queued
// errors, check-ins and metrics are delivered before returning.
export async function flushSentry(
  dsn: string | undefined,
  flush: typeof Sentry.flush = Sentry.flush,
): Promise<void> {
  if (!dsn?.trim()) return;
  try {
    await flush(2000);
  } catch {
    // Monitoring must never fail a sender run.
  }
}

export function captureFailureRate(
  rate: number,
  dsn: string | undefined,
): void {
  if (dsn?.trim())
    Sentry.metrics.gauge("send_failure_rate_last_hour", rate, {
      unit: "ratio",
    });
}
