import type { ScheduleRow } from "./schedules";

export type ConnectionStatus = "connected" | "needs_reconnect" | "disconnected";

export type ScheduleState = {
  /** Status pill text. */
  label: string;
  tone: "teal" | "muted" | "warn";
  /**
   * Replaces the next-send time when the schedule will not send as shown:
   * paused by the user, or waiting on a Gmail connection.
   */
  note: string | null;
};

/**
 * What a schedule card says about itself, given the schedule's own status and
 * the account's Gmail connection. The same answer is used on the dashboard and
 * the history page so the two never disagree.
 */
export function scheduleState(
  status: ScheduleRow["status"],
  connection: ConnectionStatus,
): ScheduleState {
  if (status === "sending")
    return { label: "Sending", tone: "teal", note: null };
  if (status === "paused") {
    return {
      label: "Paused",
      tone: "muted",
      note: "Paused. Won't send until you resume.",
    };
  }
  if (connection === "needs_reconnect") {
    return {
      label: "Needs reconnect",
      tone: "warn",
      note: "Paused until you reconnect Gmail.",
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
