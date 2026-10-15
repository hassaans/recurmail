"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import styles from "./ConfirmDialog.module.css";
import controls from "./controls.module.css";

type ConfirmFormProps = {
  /** Visible label of the button that opens the confirmation. */
  trigger: string;
  triggerStyle: "dangerQuiet" | "secondary" | "quiet";
  title: string;
  description: string;
  confirmLabel: string;
  /** Label shown on the confirm button while the request runs. */
  pendingLabel: string;
  /** Same-origin post target, e.g. /api/gmail/disconnect. */
  action: string;
  tone?: "danger" | "default";
};

const failedMessage =
  "That could not finish. Check your connection and try again.";

// A confirmed post for server pages. Props are plain data so the component
// can sit behind the server/client boundary. The confirmation is the native
// <dialog>, so it is modal and keyboard-accessible. The confirm button posts
// the form in the background and then follows the server's redirect, which
// keeps the pending label on screen until the next page arrives and lets a
// failed request report inside the dialog instead of on a blank page.
export default function ConfirmForm({
  trigger,
  triggerStyle,
  title,
  description,
  confirmLabel,
  pendingLabel,
  action,
  tone = "default",
}: ConfirmFormProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(action, {
        method: "POST",
        credentials: "same-origin",
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`POST ${action} failed with ${response.status}`);
      }
      // The server answers with a redirect to the page that reports the
      // outcome; land there like a plain form post would have.
      window.location.assign(response.url);
    } catch (cause) {
      console.error(cause);
      setError(failedMessage);
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={`${controls[triggerStyle]} ${controls.small}`}
        type="button"
        onClick={() => {
          setError(null);
          ref.current?.showModal();
        }}
      >
        {trigger}
      </button>
      <dialog
        ref={ref}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
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
            onClick={() => ref.current?.close()}
            disabled={pending}
          >
            Cancel
          </button>
          <form method="post" action={action} onSubmit={submit}>
            <button
              className={tone === "danger" ? controls.danger : controls.primary}
              type="submit"
              disabled={pending}
            >
              {pending ? (
                <>
                  <span className={controls.spinner} aria-hidden="true" />
                  {pendingLabel}
                </>
              ) : (
                confirmLabel
              )}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
