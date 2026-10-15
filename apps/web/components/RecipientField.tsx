"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { isValidAddress, splitAddresses } from "../lib/schedule-editor";
import styles from "./RecipientField.module.css";

export interface RecipientValue {
  /** Committed chips. */
  values: string[];
  /** Text still being typed in the input. Flushed into `values` on save. */
  draft: string;
}

export const emptyRecipients: RecipientValue = { values: [], draft: "" };

/** Chips plus whatever is still typed, de-duplicated, in order. */
export function recipientList(value: RecipientValue): string[] {
  return splitAddresses([...value.values, value.draft].join(" "));
}

export function invalidRecipientCount(value: RecipientValue): number {
  return recipientList(value).filter((item) => !isValidAddress(item)).length;
}

interface RecipientFieldProps {
  id: string;
  label: string;
  value: RecipientValue;
  onChange: (next: RecipientValue) => void;
  /** Inline error from form validation. Overrides the field's own hint. */
  error?: string;
  placeholder?: string;
  /** Extra controls rendered beside the label, such as "Add Cc". */
  aside?: ReactNode;
  /** Move focus into the input when the field first appears, for example after "Add Cc". */
  focusOnMount?: boolean;
}

function mergeAddresses(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((item) => item.toLowerCase()));
  const next = [...existing];
  for (const item of incoming) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export default function RecipientField({
  id,
  label,
  value,
  onChange,
  error,
  placeholder,
  aside,
  focusOnMount,
}: RecipientFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);
  const [announcement, setAnnouncement] = useState("");
  const baseId = useId();
  const errorId = `${id}-error`;
  const hintId = `${baseId}-hint`;
  const invalidCount = value.values.filter(
    (item) => !isValidAddress(item),
  ).length;
  const ownError =
    invalidCount > 0
      ? invalidCount === 1
        ? "One address doesn't look right. Fix or remove it."
        : `${invalidCount} addresses don't look right. Fix or remove them.`
      : "";
  const message = error || ownError;

  function commit(text: string, draft: string) {
    const incoming = splitAddresses(text);
    if (incoming.length === 0) {
      onChange({ values: value.values, draft });
      return;
    }
    const values = mergeAddresses(value.values, incoming);
    const addedCount = values.length - value.values.length;
    onChange({ values, draft });
    if (addedCount === 1) setAnnouncement(`Added ${values[values.length - 1]}`);
    else if (addedCount > 1) setAnnouncement(`Added ${addedCount} addresses`);
    else setAnnouncement("Already added");
  }

  function remove(index: number) {
    const removed = value.values[index];
    onChange({
      values: value.values.filter((_, position) => position !== index),
      draft: value.draft,
    });
    setAnnouncement(`Removed ${removed}`);
    inputRef.current?.focus();
  }

  function handleInput(event: React.ChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    if (!/[\s,;]/.test(text)) {
      onChange({ values: value.values, draft: text });
      return;
    }
    const parts = text.split(/[\s,;]+/);
    const trailing = /[\s,;]$/.test(text) ? "" : (parts.pop() ?? "");
    commit(parts.join(" "), trailing);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (value.draft.trim()) commit(value.draft, "");
      return;
    }
    if (event.key === "Tab" && value.draft.trim()) {
      commit(value.draft, "");
      return;
    }
    if (
      event.key === "Backspace" &&
      value.draft === "" &&
      value.values.length > 0
    ) {
      event.preventDefault();
      remove(value.values.length - 1);
    }
  }

  function handleBlur() {
    if (value.draft.trim()) commit(value.draft, "");
  }

  return (
    <div className={styles.field}>
      <div className={styles.head}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {value.values.length > 1 ? (
          <span className={styles.count}>{value.values.length} recipients</span>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the padding focuses the real input */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users tab straight into the input */}
      <div
        className={`${styles.box} ${message ? styles.boxInvalid : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.values.length > 0 ? (
          <ul className={styles.chips} aria-label={`${label} recipients`}>
            {value.values.map((address, index) => {
              const valid = isValidAddress(address);
              return (
                <li
                  key={address}
                  className={`${styles.chip} ${valid ? "" : styles.chipInvalid}`}
                  title={valid ? undefined : "This address doesn't look right"}
                >
                  {valid ? null : (
                    <span className={styles.srOnly}>Invalid address: </span>
                  )}
                  <span className={styles.chipText}>{address}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`Remove ${address}`}
                    onClick={() => remove(index)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <input
          ref={inputRef}
          id={id}
          className={styles.input}
          value={value.draft}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={value.values.length === 0 ? placeholder : ""}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="email"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : hintId}
        />
      </div>
      {message ? (
        <p id={errorId} className={styles.error}>
          {message}
        </p>
      ) : (
        <p id={hintId} className={styles.srOnly}>
          Type an address and press Enter or comma to add it.
        </p>
      )}
      <span className={styles.srOnly} aria-live="polite">
        {announcement}
      </span>
      {/* Rendered after the input so Tab reaches the field before the toggles; placed in the label row by the grid. */}
      {aside ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
