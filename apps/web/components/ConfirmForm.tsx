"use client";

import { useId, useRef } from "react";
import styles from "./ConfirmDialog.module.css";
import controls from "./controls.module.css";

type ConfirmFormProps = {
  /** Visible label of the button that opens the confirmation. */
  trigger: string;
  triggerStyle: "dangerQuiet" | "secondary" | "quiet";
  title: string;
  description: string;
  confirmLabel: string;
  /** Same-origin form post target, e.g. /api/gmail/disconnect. */
  action: string;
  tone?: "danger" | "default";
};

// A confirmed form post for server pages. Props are plain data so the
// component can sit behind the server/client boundary. The confirmation is
// the native <dialog>, so it is modal and keyboard-accessible without script
// beyond open/close.
export default function ConfirmForm({
  trigger,
  triggerStyle,
  title,
  description,
  confirmLabel,
  action,
  tone = "default",
}: ConfirmFormProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <>
      <button
        className={`${controls[triggerStyle]} ${controls.small}`}
        type="button"
        onClick={() => ref.current?.showModal()}
      >
        {trigger}
      </button>
      <dialog
        ref={ref}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <div className={styles.actions}>
          <button
            className={controls.secondary}
            type="button"
            onClick={() => ref.current?.close()}
          >
            Cancel
          </button>
          <form method="post" action={action}>
            <button
              className={tone === "danger" ? controls.danger : controls.primary}
              type="submit"
            >
              {confirmLabel}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
