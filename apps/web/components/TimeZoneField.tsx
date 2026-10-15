"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ensureTimeZoneOption,
  filterTimeZones,
  type TimeZoneOption,
  timeZoneLabel,
  timeZoneOptions,
} from "../lib/schedule-editor";
import styles from "./TimeZoneField.module.css";

interface TimeZoneFieldProps {
  id: string;
  /** IANA zone id. */
  value: string;
  onChange: (id: string) => void;
  error?: string;
}

const VISIBLE_LIMIT = 80;

export default function TimeZoneField({
  id,
  value,
  onChange,
  error,
}: TimeZoneFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-list`;
  const errorId = `${id}-error`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Building the full list means formatting ~400 zones, so wait for the first
  // interaction instead of doing it on mount.
  const [allOptions, setAllOptions] = useState<TimeZoneOption[] | null>(null);

  const options = useMemo(
    () => (allOptions ? ensureTimeZoneOption(allOptions, value) : []),
    [allOptions, value],
  );
  const results = useMemo(
    () => (query === null ? options : filterTimeZones(options, query)),
    [options, query],
  );
  const visible = results.slice(0, VISIBLE_LIMIT);
  const label = timeZoneLabel(value);
  const activeId =
    open && visible[activeIndex] ? `${listId}-${activeIndex}` : undefined;

  function ensureOptions(): TimeZoneOption[] {
    if (allOptions) return allOptions;
    const built = timeZoneOptions();
    setAllOptions(built);
    return built;
  }

  function openList(nextQuery: string | null) {
    const built = ensureTimeZoneOption(ensureOptions(), value);
    const list = nextQuery === null ? built : filterTimeZones(built, nextQuery);
    const current = list.findIndex((option) => option.id === value);
    setQuery(nextQuery);
    setActiveIndex(current >= 0 && current < VISIBLE_LIMIT ? current : 0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function select(option: TimeZoneOption | undefined) {
    if (!option) return;
    onChange(option.id);
    close();
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!open || !activeId) return;
    document
      .getElementById(activeId)
      ?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [open, activeId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList(query);
      else setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList(query);
      else setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveIndex(visible.length - 1);
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      select(visible[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key === "Tab" && open) {
      // Typing a unique match and tabbing away keeps it, like a native select.
      if (query && visible.length === 1) onChange(visible[0].id);
      close();
    }
  }

  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    if (popupRef.current?.contains(event.relatedTarget as Node | null)) return;
    if (open && query && visible.length === 1) onChange(visible[0].id);
    close();
  }

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        Time zone
      </label>
      <div className={styles.wrap}>
        <input
          ref={inputRef}
          id={id}
          className={`${styles.input} ${error ? styles.inputInvalid : ""}`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query === null ? label : query}
          placeholder="Search by city or region"
          onFocus={(event) => event.target.select()}
          onClick={() => {
            if (!open) openList(null);
          }}
          onChange={(event) => openList(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
        <svg className={styles.chevron} viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M6 8l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div ref={popupRef} className={styles.popup} hidden={!open}>
          <div
            id={listId}
            className={styles.list}
            role="listbox"
            aria-label="Time zones"
          >
            {visible.map((option, index) => (
              <div
                key={option.id}
                id={`${listId}-${index}`}
                className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
                role="option"
                aria-selected={option.id === value}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== activeIndex) setActiveIndex(index);
                }}
                onClick={() => select(option)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") select(option);
                }}
              >
                <span className={styles.optionName}>
                  {option.label.replace(/ \(.*$/, "")}
                </span>
                <span className={styles.optionMeta}>
                  {option.id} · {option.label.replace(/^.*, /, "")}
                </span>
              </div>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className={styles.note}>No time zone matches “{query}”.</p>
          ) : null}
          {results.length > VISIBLE_LIMIT ? (
            <p className={styles.note}>
              Keep typing to narrow the list ({results.length - VISIBLE_LIMIT}{" "}
              more).
            </p>
          ) : null}
        </div>
      </div>
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
