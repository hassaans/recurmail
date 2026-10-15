import type { ScheduleRow } from "./schedules";

/**
 * The slice of a schedule the dashboard needs. Bodies and ownership columns
 * stay on the server; only this summary crosses to the client list.
 */
export interface ScheduleSummary {
  id: string;
  subject: string;
  /** First addresses plus "and N more", built on the server. */
  recipients: string;
  rrule: string;
  timezone: string;
  status: ScheduleRow["status"];
  next_send_at: string;
}

export function summarizeSchedule(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    subject: row.subject,
    recipients: recipientSummary([...row.to, ...row.cc, ...row.bcc]),
    rrule: row.rrule,
    timezone: row.timezone,
    status: row.status,
    next_send_at: row.next_send_at,
  };
}

/**
 * Names the first two recipients so a card reads "who gets this" at a glance,
 * and counts the rest: "a@x.test, b@y.test and 3 more".
 */
export function recipientSummary(addresses: string[]): string {
  const shown = addresses.slice(0, 2);
  const more = addresses.length - shown.length;
  if (shown.length === 0) return "No recipients";
  if (more === 0) return shown.join(" and ");
  return `${shown.join(", ")} and ${more} more`;
}
