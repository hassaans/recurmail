import { occurrencesBetween } from "./schedule.ts";

/** Consumer Google domains are explicit; custom-domain Workspace uses its own cap. */
export type AccountType = "gmail.com" | "googlemail.com" | "workspace";
export type DailyLimitStatus = "ok" | "warn" | "over";

export interface LimitSchedule {
  status: "active" | "paused" | "sending";
  rrule: string;
  timezone: string;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  /** Earliest pending send, also the recurrence anchor if RRULE omits DTSTART. */
  nextSendAt?: Date;
}

export interface DailyLimitResult {
  status: DailyLimitStatus;
  /** Recipient deliveries in the busiest rolling 24-hour window. */
  count: number;
  limit: number;
  window: { start: Date; end: Date; occurrenceCount: number } | null;
  range: { start: Date; end: Date };
  totalRecipients: number;
  occurrenceCount: number;
}

const DAY_MS = 86_400_000;

/**
 * Forecast active schedules over [now, now + 30 elapsed days]. Rolling windows
 * are [start, start + 24 hours), so sends exactly 24 hours apart do not overlap.
 * Count every To/Cc/Bcc entry per send, including duplicate addresses.
 */
export function dailyLimitCheck(
  schedules: readonly LimitSchedule[],
  accountType: AccountType,
  now: Date = new Date(),
): DailyLimitResult {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid now Date");
  let limit: number;
  switch (accountType) {
    case "gmail.com":
    case "googlemail.com":
      limit = 500;
      break;
    case "workspace":
      limit = 2000;
      break;
    default:
      throw new RangeError("Unknown Google account type");
  }
  const end = new Date(now.getTime() + 30 * DAY_MS);
  if (!Number.isFinite(end.getTime()))
    throw new RangeError("Forecast range exceeds Date bounds");
  const occurrences: { time: number; recipients: number }[] = [];
  for (const schedule of schedules) {
    if (schedule.status !== "active") continue;
    const recipients =
      schedule.to.length +
      (schedule.cc?.length ?? 0) +
      (schedule.bcc?.length ?? 0);
    const anchor = schedule.nextSendAt ?? now;
    const from = new Date(Math.max(now.getTime(), anchor.getTime()));
    for (const date of occurrencesBetween(
      schedule.rrule,
      schedule.timezone,
      from,
      end,
      anchor,
    )) {
      occurrences.push({ time: date.getTime(), recipients });
    }
  }
  occurrences.sort((a, b) => a.time - b.time);
  let count = 0;
  let running = 0;
  let right = 0;
  let window: DailyLimitResult["window"] = null;
  for (let left = 0; left < occurrences.length; left++) {
    const start = occurrences[left].time;
    while (
      right < occurrences.length &&
      occurrences[right].time < start + DAY_MS
    ) {
      running += occurrences[right].recipients;
      right++;
    }
    if (window === null || running > count) {
      count = running;
      window = {
        start: new Date(start),
        end: new Date(start + DAY_MS),
        occurrenceCount: right - left,
      };
    }
    running -= occurrences[left].recipients;
  }
  return {
    status: count > limit ? "over" : count >= 400 ? "warn" : "ok",
    count,
    limit,
    window,
    range: { start: new Date(now.getTime()), end },
    totalRecipients: occurrences.reduce(
      (sum, occurrence) => sum + occurrence.recipients,
      0,
    ),
    occurrenceCount: occurrences.length,
  };
}
