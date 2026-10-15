import type { ScheduleRow } from "./schedules";

/**
 * The state of the Gmail account a schedule sends from. "none" means the
 * schedule has no sender: its account was disconnected and nothing has been
 * chosen in its place.
 */
export type ConnectionStatus =
  | "connected"
  | "needs_reconnect"
  | "disconnected"
  | "none";

/**
 * Why a paused schedule is finished, as plain data so it can cross to client
 * components and be rendered the same way on the dashboard and history page.
 * Derived on the server by `finishedInfo` in schedule-finished.ts.
 */
export type FinishedInfo =
  | {
      kind: "count";
      /** The COUNT in the rule. */
      total: number;
      /** Rows in send_log with status "sent", when the caller counted them. */
      sent: number | null;
    }
  | {
      kind: "until";
      /** The UNTIL date in the schedule's time zone, formatted for display. */
      endedOn: string;
    }
  | { kind: "ended" };

export type ScheduleState = {
  /** Status pill text. */
  label: string;
  tone: "teal" | "muted" | "warn";
  /**
   * Replaces the next-send time when the schedule will not send as shown:
   * finished, paused by the user, or waiting on a Gmail account.
   */
  note: string | null;
};

export const NO_SENDER_NOTE = "No sender. Choose a Gmail account.";

/** The status note for a finished schedule. */
export function finishedNote(info: FinishedInfo): string {
  if (info.kind === "count") {
    if (info.sent !== null)
      return `Finished. Sent ${info.sent} of ${info.total}.`;
    return `Finished after ${info.total} ${info.total === 1 ? "send" : "sends"}.`;
  }
  if (info.kind === "until") return `Finished. Ended on ${info.endedOn}.`;
  return "Finished. The last send has gone out.";
}

/**
 * What a schedule card says about itself, given the schedule's own status,
 * whether its rule has run out, and the state of the Gmail account it sends
 * from. The same answer is used on the dashboard and the history page so the
 * two never disagree.
 *
 * A schedule without a sender, or whose sender needs reconnecting, is always
 * paused by the server, so those states come before the plain paused copy:
 * the card says what to do instead of offering a Resume that cannot work.
 */
export function scheduleState(
  status: ScheduleRow["status"],
  connection: ConnectionStatus,
  finished: FinishedInfo | null = null,
  senderEmail: string | null = null,
): ScheduleState {
  if (status === "sending")
    return { label: "Sending", tone: "teal", note: null };
  if (status === "paused" && finished)
    return { label: "Finished", tone: "muted", note: finishedNote(finished) };
  if (connection === "none")
    return { label: "No sender", tone: "warn", note: NO_SENDER_NOTE };
  if (connection === "needs_reconnect") {
    return {
      label: "Needs reconnect",
      tone: "warn",
      note: `Paused until you reconnect ${senderEmail ?? "Gmail"}.`,
    };
  }
  if (status === "paused") {
    return {
      label: "Paused",
      tone: "muted",
      note: "Paused. Won't send until you resume.",
    };
  }
  if (connection === "disconnected") {
    return {
      label: "Waiting for Gmail",
      tone: "warn",
      note: "Won't send until you connect Gmail.",
    };
  }
  return { label: "Active", tone: "teal", note: null };
}

export function countSchedules(count: number): string {
  return `${count} ${count === 1 ? "schedule" : "schedules"}`;
}
