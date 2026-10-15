"use client";

import { nextOccurrence, presets, type Weekday } from "@recurmail/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  describeSchedule,
  isKnownTimeZone,
  localTimeFromRule,
  normalizeLink,
  ordinal,
  type Repeat,
  repeatFromRule,
  scheduleDefaults,
  sendTimeParts,
  sortWeekdays,
  timeZoneRegionName,
  WEEKDAYS,
  weekdaysFromRule,
} from "../lib/schedule-editor";
import BrandMark from "./BrandMark";
import RecipientField, {
  emptyRecipients,
  invalidRecipientCount,
  type RecipientValue,
  recipientList,
} from "./RecipientField";
import styles from "./ScheduleEditor.module.css";
import TimeZoneField from "./TimeZoneField";

interface ExistingSchedule {
  subject: string;
  body_text: string;
  body_html: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  rrule: string;
  timezone: string;
}

interface FieldErrors {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  message?: string;
  days?: string;
  custom?: string;
  timezone?: string;
}

type FormatCommand =
  | "bold"
  | "italic"
  | "insertUnorderedList"
  | "insertOrderedList"
  | "createLink";

const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "custom", label: "Custom" },
];

const WEEKDAY_KEYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];
const ALL_DAYS: Weekday[] = WEEKDAYS.map((day) => day.key);

const TOOLBAR: {
  command: FormatCommand;
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
}[] = [
  {
    command: "bold",
    label: "Bold",
    shortcut: "Ctrl+B",
    icon: (
      <path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7zM7 12h6.5a3.5 3.5 0 0 1 0 7H7z" />
    ),
  },
  {
    command: "italic",
    label: "Italic",
    shortcut: "Ctrl+I",
    icon: <path d="M14 5h5M5 19h5M14 5l-4 14" />,
  },
  {
    command: "insertUnorderedList",
    label: "Bulleted list",
    icon: (
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    command: "insertOrderedList",
    label: "Numbered list",
    icon: (
      <>
        <path d="M10 6h10M10 12h10M10 18h10" />
        <path d="M4 4.5h1.3V8M3.4 10.6h2.3l-2.3 2.8h2.3M3.4 15.8h2a1.1 1.1 0 0 1 0 2.2h-.6a1.1 1.1 0 0 1 0 2.2h-2" />
      </>
    ),
  },
  {
    command: "createLink",
    label: "Insert link",
    shortcut: "Ctrl+K",
    icon: (
      <>
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
        <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
      </>
    ),
  },
];

function RepeatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v2a3 3 0 0 1-3 3H3" />
      </g>
    </svg>
  );
}

function Callout({
  tone,
  role,
  children,
  calloutRef,
}: {
  tone: "danger" | "warn";
  role: "alert" | "status";
  children: React.ReactNode;
  calloutRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={calloutRef}
      className={`${styles.callout} ${tone === "danger" ? styles.calloutDanger : styles.calloutWarn}`}
      role={role}
      tabIndex={-1}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3l9.5 16.5h-19z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M12 10v4.5M12 17.2v.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <p>{children}</p>
    </div>
  );
}

export default function ScheduleEditor({
  scheduleId,
}: {
  scheduleId?: string;
}) {
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState<RecipientValue>(emptyRecipients);
  const [cc, setCc] = useState<RecipientValue>(emptyRecipients);
  const [bcc, setBcc] = useState<RecipientValue>(emptyRecipients);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("weekly");
  const [selectedDays, setSelectedDays] = useState<Weekday[]>(["MO"]);
  const [monthDay, setMonthDay] = useState(1);
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState("UTC");
  const [customRule, setCustomRule] = useState(
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
  );
  const [loading, setLoading] = useState(Boolean(scheduleId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [messageEmpty, setMessageEmpty] = useState(true);
  const [activeFormats, setActiveFormats] = useState<
    Partial<Record<FormatCommand, boolean>>
  >({});
  const [bodyContent, setBodyContent] = useState<{
    html: string | null;
    text: string;
  } | null>(null);

  // New schedules start in the browser's zone at the next whole hour on today's
  // weekday. Existing schedules keep what was saved.
  useEffect(() => {
    if (scheduleId) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const defaults = scheduleDefaults(new Date(), zone);
    setTimezone(zone);
    setSelectedDays([defaults.weekday]);
    setTime(defaults.time);
  }, [scheduleId]);

  useEffect(() => {
    if (loading || !bodyContent || !bodyRef.current) return;
    bodyRef.current.innerHTML = bodyContent.html ?? "";
    if (!bodyContent.html) bodyRef.current.textContent = bodyContent.text;
    setMessageEmpty(!bodyRef.current.innerText.trim());
  }, [bodyContent, loading]);

  useEffect(() => {
    if (!scheduleId) return;
    let cancelled = false;
    fetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
      credentials: "same-origin",
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.message ?? "Could not load schedule");
        return result.schedule as ExistingSchedule;
      })
      .then((existing) => {
        if (cancelled) return;
        setSubject(existing.subject);
        setTo({ values: existing.to, draft: "" });
        setCc({ values: existing.cc, draft: "" });
        setBcc({ values: existing.bcc, draft: "" });
        setShowCc(existing.cc.length > 0);
        setShowBcc(existing.bcc.length > 0);
        setTimezone(existing.timezone);
        const mode = repeatFromRule(existing.rrule);
        setRepeat(mode);
        setTime(localTimeFromRule(existing.rrule));
        const days = weekdaysFromRule(existing.rrule);
        if (days.length > 0) setSelectedDays(days);
        const monthDayField = /BYMONTHDAY=(\d+)/i.exec(existing.rrule);
        if (monthDayField) setMonthDay(Number(monthDayField[1]));
        setCustomRule(
          existing.rrule
            .replace(/^DTSTART[^\n]*\n/i, "")
            .replace(/^RRULE:/i, ""),
        );
        setBodyContent({ html: existing.body_html, text: existing.body_text });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Could not load schedule",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  // Keep toolbar pressed states in sync with the caret position.
  useEffect(() => {
    function update() {
      const body = bodyRef.current;
      const selection = document.getSelection();
      if (
        !body ||
        !selection?.anchorNode ||
        !body.contains(selection.anchorNode)
      )
        return;
      setActiveFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        insertUnorderedList: document.queryCommandState("insertUnorderedList"),
        insertOrderedList: document.queryCommandState("insertOrderedList"),
      });
    }
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const rrule = useMemo(() => {
    try {
      const [hourText, minuteText] = time.split(":");
      const clock = { hour: Number(hourText), minute: Number(minuteText) };
      if (repeat === "custom") {
        const validated = presets.custom(customRule);
        const lines = validated.split("\n");
        const ruleIndex = lines.findIndex((line) => /^RRULE:/i.test(line));
        const prefix = ruleIndex < 0 ? "RRULE:" : "";
        const raw =
          ruleIndex < 0 ? lines[0] : lines[ruleIndex].replace(/^RRULE:/i, "");
        const fields = raw
          .split(";")
          .filter((field) => !/^BY(?:HOUR|MINUTE|SECOND)=/i.test(field));
        fields.push(
          `BYHOUR=${clock.hour}`,
          `BYMINUTE=${clock.minute}`,
          "BYSECOND=0",
        );
        if (ruleIndex < 0)
          return presets.custom(`${prefix}${fields.join(";")}`);
        lines[ruleIndex] = `RRULE:${fields.join(";")}`;
        return presets.custom(lines.join("\n"));
      }
      if (repeat === "daily") return presets.daily(clock);
      if (repeat === "weekly") return presets.weekly(selectedDays, clock);
      return presets.monthly(monthDay, clock);
    } catch {
      return "";
    }
  }, [customRule, monthDay, repeat, selectedDays, time]);

  const nextSends = useMemo(() => {
    if (!rrule || !isKnownTimeZone(timezone)) return [];
    try {
      const sends: Date[] = [];
      let after = new Date();
      for (let index = 0; index < 5; index++) {
        const next = nextOccurrence(rrule, timezone, after);
        if (!next) break;
        sends.push(next);
        after = next;
      }
      return sends;
    } catch {
      return [];
    }
  }, [rrule, timezone]);

  const summary = describeSchedule({
    repeat,
    days: selectedDays,
    monthDay,
    time,
    timeZone: timezone,
  });
  const zoneName = isKnownTimeZone(timezone)
    ? timeZoneRegionName(timezone, new Date())
    : timezone;

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const toList = recipientList(to);
    if (toList.length === 0) errors.to = "Add at least one recipient.";
    else if (invalidRecipientCount(to) > 0)
      errors.to = "Fix or remove the highlighted addresses.";
    if (invalidRecipientCount(cc) > 0)
      errors.cc = "Fix or remove the highlighted addresses.";
    if (invalidRecipientCount(bcc) > 0)
      errors.bcc = "Fix or remove the highlighted addresses.";
    if (!subject.trim()) errors.subject = "Add a subject.";
    if (messageEmpty) errors.message = "Write a message.";
    if (repeat === "weekly" && selectedDays.length === 0)
      errors.days = "Pick at least one day.";
    if (repeat === "custom" && !rrule)
      errors.custom =
        "This rule isn't valid. Use RRULE syntax such as FREQ=WEEKLY;INTERVAL=2;BYDAY=MO.";
    if (!isKnownTimeZone(timezone))
      errors.timezone = "Pick a time zone from the list.";
    return errors;
  }

  const fieldErrors = submitted ? validate() : {};

  function focusFirstError(errors: FieldErrors) {
    const order: [keyof FieldErrors, string][] = [
      ["to", "to"],
      ["cc", "cc"],
      ["bcc", "bcc"],
      ["subject", "subject"],
      ["message", "message"],
      ["days", "day-MO"],
      ["custom", "custom-rule"],
      ["timezone", "timezone"],
    ];
    for (const [key, id] of order) {
      if (errors[key]) {
        document.getElementById(id)?.focus();
        return;
      }
    }
  }

  function format(command: FormatCommand) {
    if (command === "createLink") {
      const url = normalizeLink(
        window.prompt("Link URL (http, https or mailto)") ?? "",
      );
      if (!url) return;
      document.execCommand(command, false, url);
    } else {
      document.execCommand(command);
    }
    bodyRef.current?.focus();
    setActiveFormats({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      insertUnorderedList: document.queryCommandState("insertUnorderedList"),
      insertOrderedList: document.queryCommandState("insertOrderedList"),
    });
  }

  function handleToolbarKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = (current + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function handleEditorKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      format("createLink");
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setWarning("");
    setSubmitted(true);
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors);
      return;
    }
    const bodyHtml = bodyRef.current?.innerHTML ?? "";
    const bodyText = bodyRef.current?.innerText ?? "";
    const payload = {
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      to: recipientList(to),
      cc: recipientList(cc),
      bcc: recipientList(bcc),
      rrule,
      timezone,
    };
    setSaving(true);
    try {
      const response = await fetch(
        scheduleId
          ? `/api/schedules/${encodeURIComponent(scheduleId)}`
          : "/api/schedules",
        {
          method: scheduleId ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message ?? "Could not save schedule");
      const returnedWarning =
        typeof result.warning === "string" ? result.warning : "";
      setWarning(returnedWarning);
      const query = new URLSearchParams({ saved: "1", id: result.schedule.id });
      if (returnedWarning) query.set("warning", returnedWarning);
      router.push(`/dashboard?${query.toString()}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save schedule",
      );
      setSaving(false);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
  }

  const firstSend = nextSends[0] ? sendTimeParts(nextSends[0], timezone) : null;

  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#editor">
        Skip to schedule editor
      </a>
      <header className={styles.header}>
        <a
          className={styles.logo}
          href="/dashboard"
          aria-label="RecurMail home"
        >
          <BrandMark />
          RecurMail
        </a>
        <a href="/dashboard">Dashboard</a>
      </header>
      <main id="editor" className={styles.main}>
        <p className={styles.eyebrow}>Set up a repeating email</p>
        <h1>{scheduleId ? "Edit schedule" : "New schedule"}</h1>
        {warning ? (
          <Callout tone="warn" role="status">
            {warning}
          </Callout>
        ) : null}
        {loading ? (
          <p className={styles.loading} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            Loading schedule…
          </p>
        ) : (
          <form className={styles.form} onSubmit={save} noValidate>
            <section className={styles.card} aria-labelledby="message-title">
              <div className={styles.cardHead}>
                <h2 id="message-title">Email</h2>
                <p>Who gets it and what it says.</p>
              </div>
              <RecipientField
                id="to"
                label="To"
                value={to}
                onChange={setTo}
                error={fieldErrors.to}
                placeholder="name@example.com"
                aside={
                  showCc && showBcc ? null : (
                    <>
                      {showCc ? null : (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => setShowCc(true)}
                        >
                          Add Cc
                        </button>
                      )}
                      {showBcc ? null : (
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => setShowBcc(true)}
                        >
                          Add Bcc
                        </button>
                      )}
                    </>
                  )
                }
              />
              {showCc ? (
                <RecipientField
                  id="cc"
                  label="Cc"
                  value={cc}
                  onChange={setCc}
                  error={fieldErrors.cc}
                  placeholder="Copy someone"
                  focusOnMount={cc.values.length === 0}
                />
              ) : null}
              {showBcc ? (
                <RecipientField
                  id="bcc"
                  label="Bcc"
                  value={bcc}
                  onChange={setBcc}
                  error={fieldErrors.bcc}
                  placeholder="Copy someone privately"
                  focusOnMount={bcc.values.length === 0}
                />
              ) : null}
              <div className={styles.field}>
                <label htmlFor="subject">Subject</label>
                <input
                  id="subject"
                  className={fieldErrors.subject ? styles.invalid : ""}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  required
                  maxLength={998}
                  aria-invalid={fieldErrors.subject ? true : undefined}
                  aria-describedby={
                    fieldErrors.subject ? "subject-error" : undefined
                  }
                />
                {fieldErrors.subject ? (
                  <p id="subject-error" className={styles.fieldError}>
                    {fieldErrors.subject}
                  </p>
                ) : null}
              </div>
              <div className={styles.field}>
                <label htmlFor="message">Message</label>
                <div
                  className={`${styles.editor} ${fieldErrors.message ? styles.invalid : ""}`}
                >
                  <div
                    ref={toolbarRef}
                    className={styles.toolbar}
                    role="toolbar"
                    aria-label="Message formatting"
                    aria-controls="message"
                    onKeyDown={handleToolbarKeys}
                  >
                    {TOOLBAR.map((tool, index) => (
                      <button
                        key={tool.command}
                        type="button"
                        className={styles.tool}
                        aria-label={tool.label}
                        title={
                          tool.shortcut
                            ? `${tool.label} (${tool.shortcut})`
                            : tool.label
                        }
                        aria-pressed={
                          tool.command === "createLink"
                            ? undefined
                            : Boolean(activeFormats[tool.command])
                        }
                        tabIndex={index === 0 ? 0 : -1}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => format(tool.command)}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          {tool.icon}
                        </svg>
                      </button>
                    ))}
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: a contenteditable region provides rich text editing */}
                  <div
                    id="message"
                    ref={bodyRef}
                    className={styles.body}
                    role="textbox"
                    aria-label="Message"
                    aria-multiline="true"
                    data-placeholder="Write the message that goes out each time."
                    aria-invalid={fieldErrors.message ? true : undefined}
                    aria-describedby={
                      fieldErrors.message ? "message-error" : undefined
                    }
                    tabIndex={0}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={(event) =>
                      setMessageEmpty(!event.currentTarget.innerText.trim())
                    }
                    onKeyDown={handleEditorKeys}
                  />
                </div>
                {fieldErrors.message ? (
                  <p id="message-error" className={styles.fieldError}>
                    {fieldErrors.message}
                  </p>
                ) : null}
              </div>
            </section>

            <section className={styles.card} aria-labelledby="schedule-title">
              <div className={styles.cardHead}>
                <h2 id="schedule-title">Schedule</h2>
                <p>How often it goes out, and when.</p>
              </div>
              <fieldset className={styles.fieldset}>
                <legend className={styles.legend}>Repeat</legend>
                <div className={styles.segmented}>
                  {REPEAT_OPTIONS.map((option) => (
                    <label key={option.value} className={styles.segment}>
                      <input
                        type="radio"
                        name="repeat"
                        value={option.value}
                        checked={repeat === option.value}
                        onChange={() => setRepeat(option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {repeat === "weekly" ? (
                <fieldset
                  className={styles.fieldset}
                  aria-describedby={fieldErrors.days ? "days-error" : undefined}
                >
                  <legend className={styles.legend}>Days</legend>
                  <div
                    className={`${styles.days} ${fieldErrors.days ? styles.daysInvalid : ""}`}
                  >
                    {WEEKDAYS.map((day) => (
                      <label key={day.key} className={styles.day}>
                        <input
                          id={`day-${day.key}`}
                          type="checkbox"
                          aria-label={day.name}
                          checked={selectedDays.includes(day.key)}
                          onChange={(event) =>
                            setSelectedDays((current) =>
                              sortWeekdays(
                                event.target.checked
                                  ? [...current, day.key]
                                  : current.filter((item) => item !== day.key),
                              ),
                            )
                          }
                        />
                        <span aria-hidden="true">{day.letter}</span>
                      </label>
                    ))}
                  </div>
                  <div className={styles.quickPicks}>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setSelectedDays(WEEKDAY_KEYS)}
                    >
                      Weekdays
                    </button>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setSelectedDays(ALL_DAYS)}
                    >
                      Every day
                    </button>
                  </div>
                  {fieldErrors.days ? (
                    <p id="days-error" className={styles.fieldError}>
                      {fieldErrors.days}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {repeat === "monthly" ? (
                <div className={styles.field}>
                  <label htmlFor="month-day">Date of month</label>
                  <div className={styles.selectWrap}>
                    <select
                      id="month-day"
                      value={monthDay}
                      onChange={(event) =>
                        setMonthDay(Number(event.target.value))
                      }
                      aria-describedby="month-day-hint"
                    >
                      {Array.from({ length: 31 }, (_, index) => index + 1).map(
                        (day) => (
                          <option key={day} value={day}>
                            {ordinal(day)}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  {monthDay > 28 ? (
                    <p id="month-day-hint" className={styles.hint}>
                      Months without a {ordinal(monthDay)} are skipped.
                    </p>
                  ) : (
                    <p id="month-day-hint" className={styles.srOnly}>
                      Months without this date are skipped.
                    </p>
                  )}
                </div>
              ) : null}
              {repeat === "custom" ? (
                <div className={styles.field}>
                  <label htmlFor="custom-rule">Custom rule</label>
                  <textarea
                    id="custom-rule"
                    className={`${styles.mono} ${fieldErrors.custom ? styles.invalid : ""}`}
                    value={customRule}
                    onChange={(event) => setCustomRule(event.target.value)}
                    rows={3}
                    spellCheck={false}
                    aria-invalid={fieldErrors.custom ? true : undefined}
                    aria-describedby={
                      fieldErrors.custom
                        ? "custom-rule-error"
                        : "custom-rule-hint"
                    }
                  />
                  {fieldErrors.custom ? (
                    <p id="custom-rule-error" className={styles.fieldError}>
                      {fieldErrors.custom}
                    </p>
                  ) : (
                    <p id="custom-rule-hint" className={styles.hint}>
                      An iCalendar RRULE. The time below replaces any hour in
                      the rule.
                    </p>
                  )}
                </div>
              ) : null}
              <div className={styles.whenRow}>
                <div className={styles.field}>
                  <label htmlFor="time">Time</label>
                  <input
                    id="time"
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    required
                  />
                </div>
                <TimeZoneField
                  id="timezone"
                  value={timezone}
                  onChange={setTimezone}
                  error={fieldErrors.timezone}
                />
              </div>

              <div className={styles.summary} data-testid="schedule-summary">
                <RepeatIcon />
                <div>
                  <strong>{summary}</strong>
                  <small>
                    {firstSend
                      ? `First send ${firstSend.weekday}, ${firstSend.month} ${firstSend.day} at ${firstSend.time}`
                      : "Finish the schedule to see the first send."}
                  </small>
                </div>
              </div>

              <div className={styles.previewHead}>
                <h3>Next 5 send times</h3>
                <span className={styles.zoneTag}>{zoneName}</span>
              </div>
              <ol className={styles.preview} data-testid="next-send-preview">
                {nextSends.length ? (
                  nextSends.map((date) => {
                    const parts = sendTimeParts(date, timezone);
                    const longWeekday = new Intl.DateTimeFormat("en-US", {
                      weekday: "long",
                      timeZone: timezone,
                    }).format(date);
                    return (
                      <li key={date.toISOString()}>
                        <span className={styles.dateTile} aria-hidden="true">
                          <span className={styles.tileMonth}>
                            {parts.month}
                          </span>
                          <strong className={styles.tileDay}>
                            {parts.day}
                          </strong>
                        </span>
                        <span className={styles.when}>
                          <strong className={styles.whenTitle}>
                            {longWeekday} · {parts.time}
                          </strong>
                          <span className={styles.whenDate}>
                            {parts.month} {parts.day}, {parts.year}
                          </span>
                        </span>
                      </li>
                    );
                  })
                ) : (
                  <li className={styles.previewEmpty}>
                    Finish the repeat pattern and time zone to preview send
                    times.
                  </li>
                )}
              </ol>
            </section>

            {error ? (
              <Callout tone="danger" role="alert" calloutRef={errorRef}>
                {error}
              </Callout>
            ) : null}

            <div className={styles.actions}>
              <a className={styles.secondary} href="/dashboard">
                Cancel
              </a>
              <button
                className={styles.primary}
                type="submit"
                disabled={saving}
                aria-busy={saving || undefined}
              >
                {saving ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </form>
        )}
      </main>
      <footer className={styles.footer}>
        Gmail is a trademark of Google LLC. RecurMail is not affiliated with
        Google.
      </footer>
    </div>
  );
}
