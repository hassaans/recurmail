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

export function startCronCheckIn(
  dsn: string | undefined,
  monitorSlug: string | undefined,
): { monitorSlug: string; checkInId: string } | null {
  const slug = monitorSlug?.trim();
  if (!slug || !dsn?.trim()) return null;
  const checkInId = Sentry.captureCheckIn({
    monitorSlug: slug,
    status: "in_progress",
  });
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

export function captureFailureRate(
  rate: number,
  dsn: string | undefined,
): void {
  if (dsn?.trim())
    Sentry.metrics.gauge("send_failure_rate_last_hour", rate, {
      unit: "ratio",
    });
}
