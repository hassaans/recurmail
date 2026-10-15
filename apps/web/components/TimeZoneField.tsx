"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ensureTimeZoneOption,
  filterTimeZones,
  groupTimeZones,
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

interface ListItem {
  option: TimeZoneOption;
  /** Group heading rendered above this item, when it starts a group. */
  heading: string | null;
  key: string;
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** Suggested, Common and All groups flattened into one keyboard-navigable list. */
function groupedItems(options: TimeZoneOption[], value: string): ListItem[] {
  const items: ListItem[] = [];
  for (const group of groupTimeZones(options, value, browserTimeZone())) {
    group.options.forEach((option, index) => {
      items.push({
        option,
        heading: index === 0 ? group.name : null,
        key: `${group.name}:${option.id}`,
      });
    });
  }
  return items;
}

function searchItems(options: TimeZoneOption[], query: string): ListItem[] {
  return filterTimeZones(options, query).map((option) => ({
    option,
    heading: null,
    key: option.id,
  }));
}

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
  const items = useMemo(
    () =>
      query === null
        ? groupedItems(options, value)
        : searchItems(options, query),
    [options, query, value],
  );
  const label = timeZoneLabel(value);
  const activeId =
    open && items[activeIndex] ? `${listId}-${activeIndex}` : undefined;

  function ensureOptions(): TimeZoneOption[] {
    if (allOptions) return allOptions;
    const built = timeZoneOptions();
    setAllOptions(built);
    return built;
  }

  function openList(nextQuery: string | null) {
    ensureOptions();
    setQuery(nextQuery);
    // With no query the current zone heads the Suggested group, so index 0 is
    // the selection and the list opens scrolled to it.
    setActiveIndex(0);
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
    const element = document.getElementById(activeId);
    if (!element) return;
    // Keep a heading visible above the first item of a group.
    const heading = element.previousElementSibling;
    const target =
      heading && heading.getAttribute("role") === "presentation"
        ? heading
        : element;
    target.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [open, activeId]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) openList(query);
      else setActiveIndex((index) => Math.min(index + 1, items.length - 1));
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
      setActiveIndex(items.length - 1);
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      select(items[activeIndex]?.option);
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
      if (query && items.length === 1) onChange(items[0].option.id);
      close();
    }
  }

  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    if (popupRef.current?.contains(event.relatedTarget as Node | null)) return;
    if (open && query && items.length === 1) onChange(items[0].option.id);
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
          placeholder="Search by city, country or abbreviation"
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
            {items.map((item, index) => (
              <div key={item.key} className={styles.entry}>
                {item.heading ? (
                  <div
                    className={styles.groupHead}
                    role="presentation"
                    data-testid="time-zone-group"
                  >
                    {item.heading}
                  </div>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  className={`${styles.option} ${index === activeIndex ? styles.optionActive : ""}`}
                  role="option"
                  aria-selected={item.option.id === value}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (index !== activeIndex) setActiveIndex(index);
                  }}
                  onClick={() => select(item.option)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") select(item.option);
                  }}
                >
                  <span className={styles.optionName}>
                    {item.option.label.replace(/ \(.*$/, "")}
                  </span>
                  <span className={styles.optionMeta}>
                    {item.option.id} · {item.option.label.replace(/^.*, /, "")}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {items.length === 0 ? (
            <p className={styles.note}>
              No time zone matches “{query}”. Try a city, country or
              abbreviation such as PKT.
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
