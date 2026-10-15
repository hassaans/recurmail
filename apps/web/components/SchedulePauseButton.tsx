"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import type { ScheduleRow } from "../lib/schedules";
import controls from "./controls.module.css";
import Toast, { type ToastMessage } from "./Toast";

type SchedulePauseButtonProps = {
  scheduleId: string;
  subject: string;
  status: ScheduleRow["status"];
};

// Pause or resume from the history page. Props are plain data so the server
// page can render it; after a successful change it refreshes the server
// component so the status pill and next send update in place.
export default function SchedulePauseButton({
  scheduleId,
  subject,
  status,
}: SchedulePauseButtonProps) {
  const router = useRouter();
  const [requesting, setRequesting] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const action = status === "active" ? "pause" : "resume";
  const pending = requesting || refreshing;

  async function run() {
    setRequesting(true);
    setToast(null);
    try {
      const response = await fetch(
        `/api/schedules/${encodeURIComponent(scheduleId)}/${action}`,
        { method: "POST", credentials: "same-origin" },
      );
      if (!response.ok) {
        throw new Error(`POST ${action} failed with ${response.status}`);
      }
      setToast({
        tone: "success",
        text:
          action === "pause" ? `Paused “${subject}”.` : `Resumed “${subject}”.`,
      });
      startRefresh(() => router.refresh());
    } catch (cause) {
      console.error(cause);
      setToast({
        tone: "error",
        text: `“${subject}” could not be ${
          action === "pause" ? "paused" : "resumed"
        }. Check your connection and try again.`,
      });
    } finally {
      setRequesting(false);
    }
  }

  return (
    <>
      <button
        className={status === "paused" ? controls.primary : controls.secondary}
        type="button"
        disabled={pending || status === "sending"}
        onClick={run}
      >
        {pending ? (
          <>
            <span className={controls.spinner} aria-hidden="true" />
            {action === "pause" ? "Pausing…" : "Resuming…"}
          </>
        ) : action === "pause" ? (
          "Pause"
        ) : (
          "Resume"
        )}
      </button>
      <Toast message={toast} onDismiss={dismissToast} />
    </>
  );
}
