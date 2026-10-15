"use client";

import { useState } from "react";
import {
  recipientSummary,
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

export type ScheduleListProps = {
  initialSchedules: ScheduleSummary[];
  connectionStatus: "connected" | "needs_reconnect" | "disconnected";
  loadError?: boolean;
};

type StatusTone = "teal" | "muted" | "warn";

function statusOf(
  schedule: ScheduleSummary,
  connectionStatus: ScheduleListProps["connectionStatus"],
): { label: string; tone: StatusTone } {
  if (schedule.status === "sending") return { label: "Sending", tone: "teal" };
  if (schedule.status === "paused") return { label: "Paused", tone: "muted" };
  if (connectionStatus === "needs_reconnect")
    return { label: "Needs reconnect", tone: "warn" };
  return { label: "Active", tone: "teal" };
}

const pillClass: Record<StatusTone, string> = {
  teal: controls.pillTeal,
  muted: controls.pillMuted,
  warn: controls.pillWarn,
};

// The server renders the first list; this component owns pause, resume,
// pause-all and delete, and confirms delete in a modal dialog.
export default function ScheduleList({
  initialSchedules,
  connectionStatus,
  loadError = false,
}: ScheduleListProps) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [error, setError] = useState<string | null>(
    loadError ? "Schedules could not be loaded. Refresh to try again." : null,
  );
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScheduleSummary | null>(
    null,
  );
  const canEdit = connectionStatus === "connected";

  async function reload() {
    const response = await fetch("/api/schedules", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Schedules could not be loaded.");
    const result = (await response.json()) as { schedules?: ScheduleRow[] };
    setSchedules((result.schedules ?? []).map(summarizeSchedule));
  }

  async function mutate(
    path: string,
    method: "POST" | "DELETE",
    scheduleId?: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("That schedule could not be updated.");
      const result =
        response.status === 204
          ? null
          : ((await response.json()) as { schedule?: ScheduleRow });
      if (result?.schedule) {
        const updated = summarizeSchedule(result.schedule);
        setSchedules((current) =>
          current.map((schedule) =>
            schedule.id === updated.id ? updated : schedule,
          ),
        );
      } else if (method === "DELETE" && scheduleId) {
        setSchedules((current) =>
          current.filter((schedule) => schedule.id !== scheduleId),
        );
      } else {
        await reload();
      }
      return true;
    } catch {
      setError("That schedule could not be updated. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pauseAll() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/schedules/pause-all", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Schedules could not be paused.");
      setSchedules((current) =>
        current.map((schedule) =>
          schedule.status === "active"
            ? { ...schedule, status: "paused" }
            : schedule,
        ),
      );
    } catch {
      setError("Schedules could not be paused. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ok = await mutate(
      `/api/schedules/${encodeURIComponent(pendingDelete.id)}`,
      "DELETE",
      pendingDelete.id,
    );
    if (ok) setPendingDelete(null);
  }

  const anyActive = schedules.some((schedule) => schedule.status === "active");

  return (
    <section className={styles.section} aria-label="Schedules">
      {error ? (
        <p className={controls.error} role="alert">
          {error}
        </p>
      ) : null}
      {schedules.length ? (
        <>
          <div className={styles.toolbar}>
            <p className={styles.count}>
              {schedules.length}{" "}
              {schedules.length === 1 ? "schedule" : "schedules"}
            </p>
            {anyActive ? (
              <button
                className={`${controls.quiet} ${controls.small}`}
                type="button"
                onClick={pauseAll}
                disabled={busy}
              >
                Pause all schedules
              </button>
            ) : null}
          </div>
          <ul className={styles.list}>
            {schedules.map((schedule) => {
              const status = statusOf(schedule, connectionStatus);
              const id = encodeURIComponent(schedule.id);
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
                        className={`${controls.pill} ${pillClass[status.tone]}`}
                      >
                        {status.label}
                      </span>
                    </div>
                    <p className={styles.meta}>
                      {describeCadence(
                        schedule.rrule,
                        schedule.timezone,
                        schedule.next_send_at,
                      )}{" "}
                      · {recipientSummary(schedule.recipients)}
                    </p>
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
                        className={`${controls.secondary} ${controls.small}`}
                        type="button"
                        disabled={busy || schedule.status === "sending"}
                        onClick={() =>
                          mutate(
                            `/api/schedules/${id}/${schedule.status === "active" ? "pause" : "resume"}`,
                            "POST",
                          )
                        }
                      >
                        {schedule.status === "active" ? "Pause" : "Resume"}
                      </button>
                      <span className={styles.spacer} />
                      <button
                        className={`${controls.dangerQuiet} ${controls.small}`}
                        type="button"
                        disabled={busy}
                        onClick={() => setPendingDelete(schedule)}
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
          tone="danger"
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </section>
  );
}
