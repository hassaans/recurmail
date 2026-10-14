"use client";

import { useEffect, useState } from "react";
import type { ScheduleRow } from "../lib/schedules";
import styles from "./ScheduleList.module.css";

export default function ScheduleList({ warning }: { warning?: string }) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schedules", { credentials: "same-origin" })
      .then((response) => response.json())
      .then((result: { schedules?: ScheduleRow[] }) => {
        if (!cancelled) setSchedules(result.schedules ?? []);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className={styles.section} aria-labelledby="schedules-title">
      <div className={styles.heading}>
        <h2 id="schedules-title">Your schedules</h2>
        <a className={styles.button} href="/schedules/new">
          New schedule
        </a>
      </div>
      {warning ? (
        <p className={styles.warning} role="status">
          {warning}
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
                <p>
                  Next send:{" "}
                  {new Intl.DateTimeFormat(undefined, {
                    weekday: "long",
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(schedule.next_send_at))}
                </p>
              </div>
              <a href={`/schedules/${encodeURIComponent(schedule.id)}/edit`}>
                Edit
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>No schedules yet. Create your first recurring email.</p>
      )}
    </section>
  );
}
