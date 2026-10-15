"use client";

import { useEffect, useState } from "react";
import type { ScheduleRow, SendHistoryRow } from "../lib/schedules";
import styles from "./ScheduleDetail.module.css";

type DetailResponse = { schedule?: ScheduleRow };
type HistoryResponse = { history?: SendHistoryRow[] };

export default function ScheduleDetail({ id }: { id: string }) {
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null);
  const [history, setHistory] = useState<SendHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/schedules/${encodeURIComponent(id)}`, {
        credentials: "same-origin",
      }),
      fetch(`/api/schedules/${encodeURIComponent(id)}/history`, {
        credentials: "same-origin",
      }),
    ])
      .then(async ([scheduleResponse, historyResponse]) => {
        if (scheduleResponse.status === 404 || historyResponse.status === 404)
          throw new Error("This schedule could not be found.");
        if (!scheduleResponse.ok || !historyResponse.ok)
          throw new Error("Send history could not be loaded. Try again.");
        const [scheduleResult, historyResult] = (await Promise.all([
          scheduleResponse.json(),
          historyResponse.json(),
        ])) as [DetailResponse, HistoryResponse];
        if (!scheduleResult.schedule)
          throw new Error("This schedule could not be found.");
        if (!cancelled) {
          setSchedule(scheduleResult.schedule);
          setHistory(historyResult.history ?? []);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Send history could not be loaded. Try again.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <main className={styles.page}>
      <a className={styles.back} href="/dashboard">
        Back to schedules
      </a>
      {loading ? <p role="status">Loading send history…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {schedule ? (
        <>
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Schedule details</p>
              <h1>{schedule.subject}</h1>
              <p>
                {recipientCount(schedule)} recipients ·{" "}
                {repeatSummary(schedule.rrule)}
              </p>
              <p>Status {statusLabel(schedule.status)}</p>
            </div>
            <a
              className={styles.button}
              href={`/schedules/${encodeURIComponent(schedule.id)}/edit`}
            >
              Edit schedule
            </a>
          </header>
          <section aria-labelledby="history-title" className={styles.section}>
            <h2 id="history-title">Send history</h2>
            {history.length ? (
              <ol className={styles.list}>
                {history.map((entry) => (
                  <li className={styles.entry} key={entry.id}>
                    <div className={styles.entryHeading}>
                      <strong>{statusTitle(entry.status)}</strong>
                      <time dateTime={entry.attempted_at}>
                        {formatDate(entry.attempted_at)}
                      </time>
                    </div>
                    <p>Scheduled for {formatDate(entry.scheduled_for)}</p>
                    {reason(entry) ? <p>{reason(entry)}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No send attempts yet. Your history will appear here.</p>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

function recipientCount(schedule: ScheduleRow): number {
  return schedule.to.length + schedule.cc.length + schedule.bcc.length;
}

function statusLabel(status: ScheduleRow["status"]): string {
  return status === "sending"
    ? "Sending"
    : status === "active"
      ? "Active"
      : "Paused";
}

function statusTitle(status: SendHistoryRow["status"]): string {
  return status[0].toUpperCase() + status.slice(1);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function reason(entry: SendHistoryRow): string | null {
  if (entry.status === "deferred") {
    return entry.error_code === "gmail_quota_deferred"
      ? "Gmail daily sending limit reached. This email will be tried again later."
      : "Gmail could not send this email yet. It will be tried again later.";
  }
  if (entry.status === "failed") {
    return entry.error_code === "invalid_grant"
      ? "Gmail permission needs renewing. Reconnect Gmail to resume sending."
      : "Gmail could not send this email. Check your connection and try again.";
  }
  if (entry.status === "skipped")
    return "This send was skipped because the schedule was paused.";
  return null;
}

function repeatSummary(rule: string): string {
  const content = rule.match(/(?:^|\n)RRULE:([^\n]+)/)?.[1] ?? rule;
  const fields = Object.fromEntries(
    content.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key, value];
    }),
  );
  if (fields.FREQ === "DAILY") return "Every day";
  if (fields.FREQ === "WEEKLY") return "Every week";
  if (fields.FREQ === "MONTHLY") return "Every month";
  if (fields.FREQ === "YEARLY") return "Every year";
  return "Custom recurring schedule";
}
