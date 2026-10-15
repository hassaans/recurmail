"use client";

import { useEffect, useState } from "react";
import type { ScheduleRow } from "../lib/schedules";
import styles from "./ScheduleList.module.css";

export default function ScheduleList({ warning }: { warning?: string }) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadSchedules() {
    const response = await fetch("/api/schedules", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Schedules could not be loaded.");
    const result = (await response.json()) as { schedules?: ScheduleRow[] };
    setSchedules(result.schedules ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schedules", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Schedules could not be loaded.");
        return (await response.json()) as { schedules?: ScheduleRow[] };
      })
      .then((result) => {
        if (!cancelled) setSchedules(result.schedules ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Schedules could not be loaded. Try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function mutate(
    path: string,
    method: "POST" | "DELETE",
    scheduleId?: string,
  ) {
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
        setSchedules((current) =>
          current.map((schedule) =>
            schedule.id === result.schedule?.id ? result.schedule : schedule,
          ),
        );
      } else if (method === "DELETE" && scheduleId) {
        setSchedules((current) =>
          current.filter((schedule) => schedule.id !== scheduleId),
        );
      } else {
        await loadSchedules();
      }
    } catch {
      setError("That schedule could not be updated. Try again.");
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

  return (
    <section className={styles.section} aria-labelledby="schedules-title">
      <div className={styles.heading}>
        <h2 id="schedules-title">Your schedules</h2>
        <a className={styles.button} href="/schedules/new">
          New schedule
        </a>
        {schedules.some((schedule) => schedule.status === "active") ? (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={pauseAll}
            disabled={busy}
          >
            Pause all schedules
          </button>
        ) : null}
      </div>
      {warning ? (
        <p className={styles.warning} role="status">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status">Loading schedules…</p>
      ) : schedules.length ? (
        <ul className={styles.list}>
          {schedules.map((schedule) => (
            <li className={styles.row} key={schedule.id}>
              <div>
                <h3>{schedule.subject}</h3>
                <p>{recipientSummary(schedule)}</p>
                <p>{repeatSummary(schedule.rrule)}</p>
                <p>
                  Next send{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(schedule.next_send_at))}
                </p>
                <p>
                  Status <strong>{statusLabel(schedule.status)}</strong>
                </p>
              </div>
              <div className={styles.actions}>
                <a href={`/schedules/${encodeURIComponent(schedule.id)}`}>
                  History
                </a>
                <button
                  type="button"
                  disabled={busy || schedule.status === "sending"}
                  onClick={() =>
                    mutate(
                      `/api/schedules/${encodeURIComponent(schedule.id)}/${schedule.status === "active" ? "pause" : "resume"}`,
                      "POST",
                    )
                  }
                >
                  {schedule.status === "active" ? "Pause" : "Resume"}
                </button>
                <a href={`/schedules/${encodeURIComponent(schedule.id)}/edit`}>
                  Edit
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    mutate(
                      `/api/schedules/${encodeURIComponent(schedule.id)}`,
                      "DELETE",
                      schedule.id,
                    )
                  }
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No schedules yet. Create your first recurring email.</p>
      )}
    </section>
  );
}

function recipientSummary(schedule: ScheduleRow): string {
  const count = schedule.to.length + schedule.cc.length + schedule.bcc.length;
  return `${count} ${count === 1 ? "recipient" : "recipients"}`;
}

function statusLabel(status: ScheduleRow["status"]): string {
  return status === "sending"
    ? "Sending"
    : status === "active"
      ? "Active"
      : "Paused";
}

function repeatSummary(rule: string): string {
  const content = rule.match(/(?:^|\n)RRULE:([^\n]+)/)?.[1] ?? rule;
  const fields = Object.fromEntries(
    content.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  const interval = Number(fields.INTERVAL ?? "1");
  const prefix = interval > 1 ? `Every ${interval} ` : "Every ";
  if (fields.FREQ === "DAILY")
    return interval > 1 ? `${prefix}days` : "Every day";
  if (fields.FREQ === "WEEKLY") {
    const days = (fields.BYDAY ?? "").split(",").filter(Boolean);
    const names: Record<string, string> = {
      MO: "Monday",
      TU: "Tuesday",
      WE: "Wednesday",
      TH: "Thursday",
      FR: "Friday",
      SA: "Saturday",
      SU: "Sunday",
    };
    const selected = days.map((day) => names[day]).filter(Boolean);
    const cadence = interval > 1 ? `${prefix}weeks` : "Every week";
    return selected.length
      ? `${cadence} on ${selected.join(", ").replace(/, ([^,]+)$/, " and $1")}`
      : cadence;
  }
  if (fields.FREQ === "MONTHLY")
    return fields.BYMONTHDAY
      ? `Every month on day ${fields.BYMONTHDAY}`
      : "Every month";
  if (fields.FREQ === "YEARLY") return "Every year";
  return "Custom recurring schedule";
}
