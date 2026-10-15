import { nextOccurrence } from "@recurmail/core";
import type { FinishedInfo } from "./schedule-state";
import type { ScheduleRow } from "./schedules";

type FinishedCandidate = Pick<ScheduleRow, "status" | "rrule" | "timezone">;

/**
 * When the last occurrence of a rule with COUNT or UNTIL passes, the cron
 * completes the send and pauses the schedule, keeping the stale next_send_at.
 * Such a schedule is finished: paused, and its rule has no occurrence after
 * `now`. A rule that cannot be evaluated is reported as not finished so the
 * schedule keeps its ordinary paused state.
 */
export function isFinishedSchedule(
  schedule: FinishedCandidate,
  now: Date,
): boolean {
  if (schedule.status !== "paused") return false;
  try {
    return nextOccurrence(schedule.rrule, schedule.timezone, now) === null;
  } catch (error) {
    if (error instanceof RangeError) {
      console.warn(
        "[WARN] finished_check_invalid_rule",
        error.message,
        schedule.rrule,
        schedule.timezone,
      );
      return false;
    }
    throw error;
  }
}

/** The rule's COUNT, or null when it does not end after a number of sends. */
export function ruleCount(rrule: string): number | null {
  const count = ruleField(rrule, "COUNT");
  if (!count || !/^\d+$/.test(count)) return null;
  return Number(count);
}

/**
 * Describes a finished schedule, or null when `schedule` is not finished.
 * `sent` is the number of successful sends when the caller has them handy.
 */
export function finishedInfo(
  schedule: FinishedCandidate,
  now: Date,
  sent: number | null = null,
): FinishedInfo | null {
  if (!isFinishedSchedule(schedule, now)) return null;
  const total = ruleCount(schedule.rrule);
  if (total !== null) return { kind: "count", total, sent };
  const endedOn = untilLabel(schedule.rrule, schedule.timezone, now);
  if (endedOn) return { kind: "until", endedOn };
  return { kind: "ended" };
}

function ruleField(rrule: string, key: string): string | null {
  const line =
    rrule.split(/\r?\n/).find((part) => /^RRULE:/i.test(part)) ?? rrule;
  for (const field of line.replace(/^RRULE:/i, "").split(";")) {
    const [name, value] = field.split("=", 2);
    if (name?.toUpperCase() === key) return value ?? "";
  }
  return null;
}

/**
 * "Dec 31", or "Dec 31, 2025" when the end date is not in the current year,
 * from the rule's UNTIL. A floating UNTIL already names a wall date in the
 * schedule's zone; a UTC UNTIL is converted into that zone first.
 */
function untilLabel(rrule: string, timezone: string, now: Date): string | null {
  const until = ruleField(rrule, "UNTIL");
  if (!until) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(
    until,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  try {
    const date = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour ?? 0),
        Number(minute ?? 0),
        Number(second ?? 0),
      ),
    );
    const zone = utc ? timezone : "UTC";
    const endYear = utc ? yearIn(date, timezone) : year;
    const sameYear = endYear === yearIn(now, timezone);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
      timeZone: zone,
    }).format(date);
  } catch (error) {
    if (error instanceof RangeError) {
      console.warn("[WARN] finished_until_label_failed", error.message);
      return null;
    }
    throw error;
  }
}

function yearIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(
    date,
  );
}
