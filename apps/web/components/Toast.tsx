"use client";

import { useEffect } from "react";
import styles from "./Toast.module.css";

export type ToastMessage = {
  tone: "success" | "error";
  text: string;
};

type ToastProps = {
  message: ToastMessage | null;
  onDismiss: () => void;
};

const successDismissMs = 6000;

// Action feedback. The polite status region is always in the DOM so screen
// readers announce text that appears in it; a failure mounts its own alert so
// it interrupts and stays until dismissed.
export default function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (message?.tone !== "success") return;
    const timer = setTimeout(onDismiss, successDismissMs);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);
  const body = message ? (
    <div className={`${styles.toast} ${styles[message.tone]}`}>
      <span className={styles.icon} aria-hidden="true">
        {message.tone === "success" ? (
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
      <p className={styles.text}>{message.text}</p>
      <button
        className={styles.dismiss}
        type="button"
        onClick={onDismiss}
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
  ) : null;
  return (
    <div className={styles.region}>
      <div role="status" aria-live="polite">
        {message?.tone === "success" ? body : null}
      </div>
      {message?.tone === "error" ? <div role="alert">{body}</div> : null}
    </div>
  );
}
