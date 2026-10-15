"use client";

import { useCallback, useState } from "react";
import { countSchedules, scheduleState } from "../lib/schedule-state";
import {
  type ScheduleSummary,
  summarizeSchedule,
} from "../lib/schedule-summary";
import {
  describeCadence,
  formatScheduleTime,
  repeatLabel,
} from "../lib/schedule-time";
import type { ScheduleRow } from "../lib/schedules";
import ConfirmDialog from "./ConfirmDialog";
import controls from "./controls.module.css";
import styles from "./ScheduleList.module.css";
import Toast, { type ToastMessage } from "./Toast";

export type ScheduleListProps = {
  initialSchedules: ScheduleSummary[];
  connectionStatus: "connected" | "needs_reconnect" | "disconnected";
  loadError?: boolean;
};

// Which control the user clicked. Only that control shows its pending label;
// every other control is disabled until the request settles.
type Pending =
  | { kind: "pause" | "resume"; id: string }
  | { kind: "pause-all" }
  | { kind: "resume-all" }
  | { kind: "delete" }
  | null;

type BulkAction = "pause-all" | "resume-all";

const pillClass = {
  teal: controls.pillTeal,
  muted: controls.pillMuted,
  warn: controls.pillWarn,
} as const;

function Spinner() {
  return <span className={controls.spinner} aria-hidden="true" />;
}

function schedulePath(id: string, action?: "pause" | "resume") {
  const base = `/api/schedules/${encodeURIComponent(id)}`;
  return action ? `${base}/${action}` : base;
}

// The server renders the first list; this component owns pause, resume,
// pause-all, resume-all and delete. Each action confirms when it is broad or
// destructive, shows a pending label on the clicked control, and reports the
// outcome in a live region.
export default function ScheduleList({
  initialSchedules,
  connectionStatus,
  loadError = false,
}: ScheduleListProps) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [pending, setPending] = useState<Pending>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleSummary | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const canEdit = connectionStatus === "connected";
  const busy = pending !== null;

  async function request(path: string, method: "POST" | "DELETE") {
    const response = await fetch(path, { method, credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}`);
    }
    return response.status === 204
      ? null
      : ((await response.json()) as { schedule?: ScheduleRow });
  }

  async function reload() {
    const response = await fetch("/api/schedules", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Schedules could not be loaded.");
    const result = (await response.json()) as { schedules?: ScheduleRow[] };
    setSchedules((result.schedules ?? []).map(summarizeSchedule));
  }

  function applyUpdate(row: ScheduleRow) {
    const updated = summarizeSchedule(row);
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === updated.id ? updated : schedule,
      ),
    );
  }

  async function toggle(schedule: ScheduleSummary) {
    const action = schedule.status === "active" ? "pause" : "resume";
    setPending({ kind: action, id: schedule.id });
    setToast(null);
    try {
      const result = await request(schedulePath(schedule.id, action), "POST");
      if (result?.schedule) applyUpdate(result.schedule);
      else await reload();
      setToast({
        tone: "success",
        text:
          action === "pause"
            ? `Paused “${schedule.subject}”.`
            : `Resumed “${schedule.subject}”.`,
      });
    } catch (cause) {
      console.error(cause);
      setToast({
        tone: "error",
        text: `“${schedule.subject}” could not be ${
          action === "pause" ? "paused" : "resumed"
        }. Check your connection and try again.`,
      });
    } finally {
      setPending(null);
    }
  }

  function openBulk(action: BulkAction) {
    setToast(null);
    setBulkError(null);
    setBulk(action);
  }

  function cancelBulk() {
    setBulk(null);
    setBulkError(null);
  }

  // Bulk actions confirm first, and a failure reports inside the dialog
  // because the page behind an open dialog is inert.
  async function confirmPauseAll() {
    setPending({ kind: "pause-all" });
    setBulkError(null);
    const activeCount = schedules.filter((s) => s.status === "active").length;
    try {
      const response = await fetch("/api/schedules/pause-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(`POST pause-all failed with ${response.status}`);
      }
      const result = (await response.json()) as { paused?: number };
      setSchedules((current) =>
        current.map((schedule) =>
          schedule.status === "active"
            ? { ...schedule, status: "paused" }
            : schedule,
        ),
      );
      setBulk(null);
      setToast({
        tone: "success",
        text: `Paused ${countSchedules(result.paused ?? activeCount)}.`,
      });
    } catch (cause) {
      console.error(cause);
      setBulkError(
        "Your schedules could not be paused. Check your connection and try again.",
      );
    } finally {
      setPending(null);
    }
  }

  async function confirmResumeAll() {
    setPending({ kind: "resume-all" });
    setBulkError(null);
    const paused = schedules.filter((s) => s.status === "paused");
    let resumed = 0;
    try {
      for (const schedule of paused) {
        const result = await request(
          schedulePath(schedule.id, "resume"),
          "POST",
        );
        if (result?.schedule) applyUpdate(result.schedule);
        resumed += 1;
      }
      setBulk(null);
      setToast({
        tone: "success",
        text: `Resumed ${countSchedules(resumed)}.`,
      });
    } catch (cause) {
      console.error(cause);
      setBulkError(
        resumed
          ? `${resumed} of ${paused.length} resumed. The rest could not be resumed. Check your connection and try again.`
          : "Your schedules could not be resumed. Check your connection and try again.",
      );
    } finally {
      setPending(null);
    }
  }

  function cancelDelete() {
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPending({ kind: "delete" });
    setDeleteError(null);
    try {
      await request(schedulePath(target.id), "DELETE");
      setSchedules((current) =>
        current.filter((schedule) => schedule.id !== target.id),
      );
      setPendingDelete(null);
      setToast({ tone: "success", text: "Schedule deleted." });
    } catch (cause) {
      console.error(cause);
      setDeleteError("That schedule could not be deleted. Try again.");
    } finally {
      setPending(null);
    }
  }

  const activeCount = schedules.filter((s) => s.status === "active").length;
  const pausedCount = schedules.filter((s) => s.status === "paused").length;
  const allPaused = schedules.length > 0 && pausedCount === schedules.length;
  const bulkDialog =
    bulk === "pause-all"
      ? {
          title:
            activeCount === 1
              ? "Pause this schedule?"
              : `Pause all ${activeCount} schedules?`,
          description:
            activeCount === 1
              ? "Nothing sends until you resume it."
              : "Nothing sends until you resume each one.",
          confirmLabel: "Pause all",
          pendingLabel: "Pausing all…",
          onConfirm: confirmPauseAll,
        }
      : bulk === "resume-all"
        ? {
            title:
              pausedCount === 1
                ? "Resume this schedule?"
                : `Resume all ${pausedCount} schedules?`,
            description:
              pausedCount === 1
                ? "It sends again at its next scheduled time."
                : "Each one sends again at its next scheduled time.",
            confirmLabel: "Resume all",
            pendingLabel: "Resuming all…",
            onConfirm: confirmResumeAll,
          }
        : null;

  return (
    <section className={styles.section} aria-label="Schedules">
      {loadError ? (
        <p className={controls.error} role="alert">
          Schedules could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {schedules.length ? (
        <>
          <div className={styles.toolbar}>
            <p className={styles.count}>{countSchedules(schedules.length)}</p>
            {activeCount > 0 ? (
              <button
                className={`${controls.quiet} ${controls.small}`}
                type="button"
                onClick={() => openBulk("pause-all")}
                disabled={busy}
              >
                Pause all schedules
              </button>
            ) : allPaused ? (
              <button
                className={`${controls.quiet} ${controls.small}`}
                type="button"
                onClick={() => openBulk("resume-all")}
                disabled={busy}
              >
                Resume all schedules
              </button>
            ) : null}
          </div>
          <ul className={styles.list}>
            {schedules.map((schedule) => {
              const state = scheduleState(schedule.status, connectionStatus);
              const id = encodeURIComponent(schedule.id);
              const toggleAction =
                schedule.status === "active" ? "pause" : "resume";
              const togglePending =
                pending?.kind === toggleAction && pending.id === schedule.id;
              return (
                <li className={styles.card} key={schedule.id}>
                  <div className={styles.strip}>
                    {repeatLabel(schedule.rrule)}
                  </div>
                  <div className={styles.body}>
                    <div className={styles.titleRow}>
                      <h3 className={styles.subject}>{schedule.subject}</h3>
                      <span className={controls.srOnly}>Status </span>
                      <span
                        className={`${controls.pill} ${pillClass[state.tone]}`}
                      >
                        {state.label}
                      </span>
                    </div>
                    <p className={styles.meta}>
                      {describeCadence(
                        schedule.rrule,
                        schedule.timezone,
                        schedule.next_send_at,
                      )}{" "}
                      · {schedule.recipients}
                    </p>
                    {state.note ? (
                      <p
                        className={`${styles.note} ${
                          state.tone === "warn" ? styles.noteWarn : ""
                        }`}
                      >
                        {state.note}
                      </p>
                    ) : (
                      <dl className={styles.facts}>
                        <dt>Next send</dt>
                        <dd>
                          <time dateTime={schedule.next_send_at}>
                            {formatScheduleTime(
                              schedule.next_send_at,
                              schedule.timezone,
                            )}
                          </time>
                        </dd>
                      </dl>
                    )}
                    <div className={styles.actions}>
                      {canEdit ? (
                        <a
                          className={`${controls.secondary} ${controls.small}`}
                          href={`/schedules/${id}/edit`}
                        >
                          Edit
                        </a>
                      ) : null}
                      <a
                        className={`${controls.secondary} ${controls.small}`}
                        href={`/schedules/${id}`}
                      >
                        History
                      </a>
                      <button
                        className={`${
                          schedule.status === "paused"
                            ? controls.primary
                            : controls.secondary
                        } ${controls.small}`}
                        type="button"
                        disabled={busy || schedule.status === "sending"}
                        onClick={() => toggle(schedule)}
                      >
                        {togglePending ? (
                          <>
                            <Spinner />
                            {toggleAction === "pause"
                              ? "Pausing…"
                              : "Resuming…"}
                          </>
                        ) : toggleAction === "pause" ? (
                          "Pause"
                        ) : (
                          "Resume"
                        )}
                      </button>
                      <span className={styles.spacer} />
                      <button
                        className={`${controls.dangerQuiet} ${controls.small}`}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setToast(null);
                          setPendingDelete(schedule);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className={styles.empty}>
          <h3>No schedules yet</h3>
          <p>
            Create your first recurring email. RecurMail sends it from your own
            Gmail account on the days and time you choose.
          </p>
          {canEdit ? (
            <a className={controls.secondary} href="/schedules/new">
              Create your first schedule
            </a>
          ) : null}
        </div>
      )}
      {pendingDelete ? (
        <ConfirmDialog
          open
          title="Delete this schedule?"
          description={`“${pendingDelete.subject}” will stop sending and its send history will be removed. This cannot be undone.`}
          confirmLabel="Delete schedule"
          pendingLabel="Deleting…"
          tone="danger"
          busy={pending?.kind === "delete"}
          error={deleteError}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      ) : null}
      {bulkDialog ? (
        <ConfirmDialog
          open
          title={bulkDialog.title}
          description={bulkDialog.description}
          confirmLabel={bulkDialog.confirmLabel}
          pendingLabel={bulkDialog.pendingLabel}
          busy={pending?.kind === bulk}
          error={bulkError}
          onCancel={cancelBulk}
          onConfirm={bulkDialog.onConfirm}
        />
      ) : null}
      <Toast message={toast} onDismiss={dismissToast} />
    </section>
  );
}
