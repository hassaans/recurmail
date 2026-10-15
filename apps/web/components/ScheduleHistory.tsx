import { recipientSummary } from "../lib/schedule-summary";
import {
  describeCadence,
  formatScheduleTime,
  sameMinute,
  zoneLabel,
} from "../lib/schedule-time";
import type { ScheduleRow, SendHistoryRow } from "../lib/schedules";
import controls from "./controls.module.css";
import styles from "./ScheduleHistory.module.css";

type ScheduleHistoryProps = {
  schedule: ScheduleRow;
  history: SendHistoryRow[];
  canEdit: boolean;
};

function scheduleStatus(status: ScheduleRow["status"]) {
  if (status === "sending")
    return { label: "Sending", className: controls.pillTeal };
  if (status === "paused")
    return { label: "Paused", className: controls.pillMuted };
  return { label: "Active", className: controls.pillTeal };
}

function entryStatus(status: SendHistoryRow["status"]) {
  if (status === "sent") return { label: "Sent", className: controls.pillTeal };
  if (status === "failed")
    return { label: "Failed", className: controls.pillDanger };
  if (status === "deferred")
    return { label: "Deferred", className: controls.pillWarn };
  return { label: "Skipped", className: controls.pillMuted };
}

export function reasonFor(entry: SendHistoryRow): string | null {
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

// Server-rendered send history: the schedule header and every attempt, all
// in the schedule's own timezone.
export default function ScheduleHistory({
  schedule,
  history,
  canEdit,
}: ScheduleHistoryProps) {
  const status = scheduleStatus(schedule.status);
  const recipients =
    schedule.to.length + schedule.cc.length + schedule.bcc.length;
  const zone = zoneLabel(schedule.timezone, schedule.next_send_at);
  return (
    <>
      <a className={styles.back} href="/dashboard">
        ← Back to schedules
      </a>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>Schedule</p>
            <div className={styles.title}>
              <h1>{schedule.subject}</h1>
              <span className={`${controls.pill} ${status.className}`}>
                {status.label}
              </span>
            </div>
          </div>
          {canEdit ? (
            <a
              className={controls.secondary}
              href={`/schedules/${encodeURIComponent(schedule.id)}/edit`}
            >
              Edit schedule
            </a>
          ) : null}
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Repeats</dt>
            <dd>
              {describeCadence(
                schedule.rrule,
                schedule.timezone,
                schedule.next_send_at,
              )}{" "}
              {zone}
            </dd>
          </div>
          <div>
            <dt>Next send</dt>
            <dd>
              <time dateTime={schedule.next_send_at}>
                {formatScheduleTime(schedule.next_send_at, schedule.timezone)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Recipients</dt>
            <dd>{recipientSummary(recipients)}</dd>
          </div>
        </dl>
      </header>
      <section className={styles.section} aria-labelledby="history-title">
        <h2 id="history-title">Send history</h2>
        {history.length ? (
          <ol className={styles.list}>
            {history.map((entry) => {
              const tone = entryStatus(entry.status);
              const reason = reasonFor(entry);
              return (
                <li className={styles.entry} key={entry.id}>
                  <span className={`${controls.pill} ${tone.className}`}>
                    {tone.label}
                  </span>
                  <time dateTime={entry.attempted_at}>
                    {formatScheduleTime(entry.attempted_at, schedule.timezone)}
                  </time>
                  {sameMinute(
                    entry.attempted_at,
                    entry.scheduled_for,
                  ) ? null : (
                    <p className={styles.scheduled}>
                      Scheduled for{" "}
                      {formatScheduleTime(
                        entry.scheduled_for,
                        schedule.timezone,
                      )}
                    </p>
                  )}
                  {reason ? <p>{reason}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className={styles.empty}>
            <p>No send attempts yet. Your history will appear here.</p>
          </div>
        )}
      </section>
    </>
  );
}
