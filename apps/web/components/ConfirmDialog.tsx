"use client";

import { useEffect, useId, useRef } from "react";
import styles from "./ConfirmDialog.module.css";
import controls from "./controls.module.css";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  busy?: boolean;
  /** Failure message shown inside the dialog, since the page behind it is inert. */
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

// Accessible confirmation built on the native <dialog>: modal, focus-trapped,
// Escape cancels, and the backdrop dims the page.
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = "default",
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      {error ? (
        <p className={`${controls.error} ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          className={controls.secondary}
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className={tone === "danger" ? controls.danger : controls.primary}
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
