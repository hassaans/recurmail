import type { ScheduleRow } from "./schedules";

/**
 * The slice of a schedule the dashboard needs. Bodies and ownership columns
 * stay on the server; only this summary crosses to the client list.
 */
export interface ScheduleSummary {
  id: string;
  subject: string;
  recipients: number;
  rrule: string;
  timezone: string;
  status: ScheduleRow["status"];
  next_send_at: string;
}

export function summarizeSchedule(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    subject: row.subject,
    recipients: row.to.length + row.cc.length + row.bcc.length,
    rrule: row.rrule,
    timezone: row.timezone,
    status: row.status,
    next_send_at: row.next_send_at,
  };
}

export function recipientSummary(count: number): string {
  return `${count} ${count === 1 ? "recipient" : "recipients"}`;
}
