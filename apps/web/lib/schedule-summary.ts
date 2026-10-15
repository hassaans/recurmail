import type { ConnectionStatus, FinishedInfo } from "./schedule-state";
import type { ScheduleRow } from "./schedules";

/**
 * A Gmail account as the schedule pages see it: enough to name it, pick it
 * and say whether it can send. The refresh token never leaves the server.
 */
export interface SenderAccount {
  id: string;
  email: string;
  status: Exclude<ConnectionStatus, "none">;
}

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
  /** Set on the server when a paused schedule's rule has run out. */
  finished: FinishedInfo | null;
  gmail_connection_id: string | null;
  /** The account this schedule sends from, or null once it has none. */
  sender: Pick<SenderAccount, "email" | "status"> | null;
}

/** The accounts a user can send from, in the order they were connected. */
export function senderAccounts(
  connections: {
    id: string;
    google_email: string;
    status: SenderAccount["status"];
  }[],
): SenderAccount[] {
  return connections.map((connection) => ({
    id: connection.id,
    email: connection.google_email,
    status: connection.status,
  }));
}

export function summarizeSchedule(
  row: ScheduleRow,
  finished: FinishedInfo | null = null,
  accounts: SenderAccount[] = [],
): ScheduleSummary {
  const sender = accounts.find(
    (account) => account.id === row.gmail_connection_id,
  );
  return {
    id: row.id,
    subject: row.subject,
    recipients: recipientSummary([...row.to, ...row.cc, ...row.bcc]),
    rrule: row.rrule,
    timezone: row.timezone,
    status: row.status,
    next_send_at: row.next_send_at,
    finished,
    gmail_connection_id: row.gmail_connection_id,
    sender: sender ? { email: sender.email, status: sender.status } : null,
  };
}

/** The connection state a schedule card reports on. */
export function senderStatus(
  summary: Pick<ScheduleSummary, "sender">,
): ConnectionStatus {
  return summary.sender?.status ?? "none";
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
