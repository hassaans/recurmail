"use client";

import { useEffect, useState } from "react";
import styles from "./DashboardNotices.module.css";

export type DashboardNotice = {
  tone: "success" | "warn";
  text: string;
};

type DashboardNoticesProps = {
  notices: DashboardNotice[];
};

const successDismissMs = 6000;

// Page-load notices such as "Schedule saved." or "Gmail is connected." They
// share the action toasts' look and behaviour: a success notice goes away on
// its own after a few seconds, a warning stays until closed, and the status
// region leaves the DOM once nothing is left to show.
export default function DashboardNotices({ notices }: DashboardNoticesProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const successTexts = notices
    .filter((notice) => notice.tone === "success")
    .map((notice) => notice.text);
  const successKey = successTexts.join("\n");

  useEffect(() => {
    if (!successKey) return;
    const texts = successKey.split("\n");
    const timer = setTimeout(
      () => setDismissed((current) => [...current, ...texts]),
      successDismissMs,
    );
    return () => clearTimeout(timer);
  }, [successKey]);

  const visible = notices.filter((notice) => !dismissed.includes(notice.text));
  if (visible.length === 0) return null;
  return (
    <div className={styles.notices} role="status">
      {visible.map((notice) => (
        <div
          className={`${styles.notice} ${styles[notice.tone]}`}
          key={notice.text}
        >
          <span className={styles.icon} aria-hidden="true">
            {notice.tone === "success" ? (
              <svg viewBox="0 0 20 20" fill="none" role="presentation">
                <path
                  d="m5 10.5 3.2 3.2L15 7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" fill="none" role="presentation">
                <path
                  d="M10 6v5M10 13.5v.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </span>
          <p className={styles.text}>{notice.text}</p>
          <button
            className={styles.dismiss}
            type="button"
            onClick={() => setDismissed((current) => [...current, notice.text])}
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="m6 6 8 8M14 6l-8 8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
