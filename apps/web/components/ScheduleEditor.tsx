"use client";

import { nextOccurrence, presets, type Weekday } from "@recurmail/core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track } from "../lib/analytics-client";
import {
  buildCustomRule,
  type CustomRule,
  canonicalTimeZoneId,
  customFromRule,
  defaultCustomRule,
  describeRuleText,
  describeSchedule,
  INTERVAL_UNITS,
  type IntervalUnit,
  isKnownTimeZone,
  localTimeFromRule,
  MONTH_NAMES,
  normalizeLink,
  ORDINAL_POSITIONS,
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
import type { SenderAccount } from "../lib/schedule-summary";
import { TEST_SEND_LIMIT } from "../lib/test-send-limit";
import RecipientField, {
  emptyRecipients,
  invalidRecipientCount,
  type RecipientValue,
  recipientList,
} from "./RecipientField";
import styles from "./ScheduleEditor.module.css";
import TimeZoneField, { browserTimeZone } from "./TimeZoneField";
import Toast, { type ToastMessage } from "./Toast";

interface ExistingSchedule {
  gmail_connection_id: string | null;
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
  sender?: string;
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
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const LEAVE_MESSAGE =
  "Leave without saving? The changes to this schedule will be lost.";

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

function DayChips({
  value,
  onChange,
  invalid,
}: {
  value: Weekday[];
  onChange: (days: Weekday[]) => void;
  invalid: boolean;
}) {
  return (
    <div className={`${styles.days} ${invalid ? styles.daysInvalid : ""}`}>
      {WEEKDAYS.map((day) => (
        <label
          key={day.key}
          className={styles.day}
          data-testid={`day-chip-${day.key}`}
        >
          <input
            id={`day-${day.key}`}
            type="checkbox"
            aria-label={day.name}
            checked={value.includes(day.key)}
            onChange={(event) =>
              onChange(
                sortWeekdays(
                  event.target.checked
                    ? [...value, day.key]
                    : value.filter((item) => item !== day.key),
                ),
              )
            }
          />
          <span aria-hidden="true">{day.letter}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * The rate-limit message with the retry time in the reader's own time zone.
 * The server's message only says how long to wait; a time of day is only
 * meaningful once the browser knows where the reader is.
 */
function rateLimitMessage(fallback: string, retryAt: unknown): string {
  const at = typeof retryAt === "string" ? new Date(retryAt) : null;
  if (!at || Number.isNaN(at.getTime())) return fallback;
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `You've sent ${TEST_SEND_LIMIT} test emails in the last hour. Try again at ${time}.`;
}

export default function ScheduleEditor({
  scheduleId,
  userEmail,
  accounts,
}: {
  scheduleId?: string;
  /** The signed-in account; the only address a test email ever goes to. */
  userEmail: string;
  /** Every Gmail account the user has connected, oldest first. */
  accounts: SenderAccount[];
}) {
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // The account this schedule sends from. A new schedule starts on the first
  // account that can send; an existing one keeps what was saved, which is
  // empty once that account has been disconnected.
  const [sender, setSender] = useState(() =>
    scheduleId
      ? ""
      : (accounts.find((account) => account.status === "connected")?.id ?? ""),
  );
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
  const [custom, setCustom] = useState<CustomRule>(() =>
    defaultCustomRule(new Date(), "UTC"),
  );
  // A saved rule the builder cannot show (for example one with BYSETPOS). It
  // is kept verbatim and shown as a read-only summary until replaced.
  const [lockedRule, setLockedRule] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(scheduleId));
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [messageEmpty, setMessageEmpty] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<{
    text: string;
    reconnect: boolean;
  } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);
  const [activeFormats, setActiveFormats] = useState<
    Partial<Record<FormatCommand, boolean>>
  >({});
  const [bodyContent, setBodyContent] = useState<{
    html: string | null;
    text: string;
  } | null>(null);
  // Unsaved-changes guard: a fingerprint of the form taken once it is ready,
  // plus a flag for message edits (the editor body lives outside React state).
  const baselineRef = useRef<string | null>(null);
  const bodyEditedRef = useRef(false);
  const leavingRef = useRef(false);
  const openedRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    track("editor_opened", { mode: scheduleId ? "edit" : "new" });
  }, [scheduleId]);

  // New schedules start in the browser's zone at the next whole hour on today's
  // weekday. Existing schedules keep what was saved.
  useEffect(() => {
    if (scheduleId) return;
    const zone = browserTimeZone() ?? "UTC";
    const defaults = scheduleDefaults(new Date(), zone);
    setTimezone(zone);
    setSelectedDays([defaults.weekday]);
    setTime(defaults.time);
    setCustom(defaultCustomRule(new Date(), zone));
    setReady(true);
  }, [scheduleId]);

  useEffect(() => {
    if (loading || !bodyContent || !bodyRef.current) return;
    bodyRef.current.innerHTML = bodyContent.html ?? "";
    if (!bodyContent.html) bodyRef.current.textContent = bodyContent.text;
    setMessageEmpty(!bodyRef.current.innerText.trim());
    setReady(true);
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
          throw new Error(
            result.error?.message ??
              result.message ??
              "Could not load schedule",
          );
        return result.schedule as ExistingSchedule;
      })
      .then((existing) => {
        if (cancelled) return;
        setSender(existing.gmail_connection_id ?? "");
        setSubject(existing.subject);
        setTo({ values: existing.to, draft: "" });
        setCc({ values: existing.cc, draft: "" });
        setBcc({ values: existing.bcc, draft: "" });
        setShowCc(existing.cc.length > 0);
        setShowBcc(existing.bcc.length > 0);
        // Schedules saved before the picker mapped legacy ids load under the
        // canonical name; the API keeps accepting either.
        setTimezone(canonicalTimeZoneId(existing.timezone));
        const mode = repeatFromRule(existing.rrule);
        setRepeat(mode);
        setTime(localTimeFromRule(existing.rrule));
        const days = weekdaysFromRule(existing.rrule);
        if (days.length > 0) setSelectedDays(days);
        const monthDayField = /BYMONTHDAY=(\d+)/i.exec(existing.rrule);
        if (monthDayField) setMonthDay(Number(monthDayField[1]));
        if (mode === "custom") {
          const parsed = customFromRule(existing.rrule, existing.timezone);
          if (parsed) setCustom(parsed);
          else setLockedRule(existing.rrule);
        }
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
    if (lockedRule) return lockedRule;
    try {
      const [hourText, minuteText] = time.split(":");
      const clock = { hour: Number(hourText), minute: Number(minuteText) };
      if (repeat === "custom")
        return presets.custom(buildCustomRule(custom, time, timezone));
      if (repeat === "daily") return presets.daily(clock);
      if (repeat === "weekly") return presets.weekly(selectedDays, clock);
      return presets.monthly(monthDay, clock);
    } catch {
      return "";
    }
  }, [custom, lockedRule, monthDay, repeat, selectedDays, time, timezone]);

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

  // Everything that ends up in the saved schedule, except the message body.
  const fingerprint = JSON.stringify({
    sender,
    subject,
    to,
    cc,
    bcc,
    repeat,
    selectedDays,
    monthDay,
    time,
    timezone,
    custom,
    lockedRule,
  });
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (baselineRef.current === null) baselineRef.current = fingerprint;
    dirtyRef.current =
      fingerprint !== baselineRef.current || bodyEditedRef.current;
  }, [ready, fingerprint]);

  // Leaving with unsaved edits asks first: browser close, reload and back go
  // through beforeunload; same-tab link clicks (Cancel, the shell navigation, logo) get a
  // confirm dialog. Saving clears the guard before it navigates.
  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current || leavingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function handleLinkClick(event: MouseEvent) {
      if (!dirtyRef.current || leavingRef.current) return;
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor || anchor.closest("[contenteditable]")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || anchor.getAttribute("target") === "_blank")
        return;
      if (window.confirm(LEAVE_MESSAGE)) {
        leavingRef.current = true;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleLinkClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleLinkClick, true);
    };
  }, []);

  const replaceLockedRule = useCallback(() => {
    const defaults = scheduleDefaults(new Date(), timezone);
    setLockedRule(null);
    setRepeat("weekly");
    setSelectedDays([defaults.weekday]);
    setTime(defaults.time);
    setCustom(defaultCustomRule(new Date(), timezone));
    requestAnimationFrame(() =>
      document.getElementById("repeat-weekly")?.focus(),
    );
  }, [timezone]);

  function updateCustom(patch: Partial<CustomRule>) {
    setCustom((current) => ({ ...current, ...patch }));
  }

  const summary = lockedRule
    ? describeRuleText(lockedRule, timezone)
    : describeSchedule({
        repeat,
        days: selectedDays,
        monthDay,
        time,
        timeZone: timezone,
        custom,
      });
  const zoneName = isKnownTimeZone(timezone)
    ? timeZoneRegionName(timezone, new Date())
    : timezone;

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!sender) errors.sender = "Choose a Gmail account to send from.";
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
    if (repeat === "custom" && !lockedRule) {
      if (custom.unit === "weeks" && custom.days.length === 0)
        errors.days = "Pick at least one day.";
      if (!(custom.interval >= 1))
        errors.custom = "Enter how often it repeats, 1 or more.";
      else if (custom.ends === "after" && !(custom.endCount >= 1))
        errors.custom = "Enter how many sends, 1 or more.";
      else if (custom.ends === "on" && !custom.endDate)
        errors.custom = "Pick an end date.";
      else if (!rrule) errors.custom = "Finish the repeat pattern.";
      else if (isKnownTimeZone(timezone) && nextSends.length === 0)
        errors.custom =
          "This schedule has no upcoming sends. Change the end date or count.";
    }
    if (!isKnownTimeZone(timezone))
      errors.timezone = "Pick a time zone from the list.";
    return errors;
  }

  const fieldErrors = submitted ? validate() : {};

  function focusFirstError(errors: FieldErrors) {
    const order: [keyof FieldErrors, string][] = [
      ["sender", "sender"],
      ["to", "to"],
      ["cc", "cc"],
      ["bcc", "bcc"],
      ["subject", "subject"],
      ["message", "message"],
      ["days", "day-MO"],
      ["custom", "custom-interval"],
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
      gmail_connection_id: sender,
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
        throw new Error(
          result.error?.message ?? result.message ?? "Could not save schedule",
        );
      const returnedWarning =
        typeof result.warning === "string" ? result.warning : "";
      setWarning(returnedWarning);
      const query = new URLSearchParams({ saved: "1", id: result.schedule.id });
      if (returnedWarning) query.set("warning", returnedWarning);
      leavingRef.current = true;
      dirtyRef.current = false;
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

  // A test email goes to the signed-in user only, never to the recipients
  // above, and it goes out from the account chosen in the From field.
  const selectedAccount = accounts.find((account) => account.id === sender);
  const testSender =
    selectedAccount?.status === "connected" ? selectedAccount : null;
  const testHint = !accounts.some((account) => account.status === "connected")
    ? "Connect Gmail to send yourself a test."
    : !selectedAccount
      ? "Choose a Gmail account to send from first."
      : !testSender
        ? `Reconnect ${selectedAccount.email} from your dashboard to send a test from it.`
        : !subject.trim() || messageEmpty
          ? "Add a subject and a message first."
          : null;
  const canSendTest = testHint === null && !testing;

  async function sendTest() {
    if (!canSendTest) return;
    setTestError(null);
    setToast(null);
    setTesting(true);
    // Exactly what save would send: the current draft, unsaved edits
    // included, from the account in the From field.
    const payload = {
      gmail_connection_id: sender,
      subject,
      body_text: bodyRef.current?.innerText ?? "",
      body_html: bodyRef.current?.innerHTML ?? "",
    };
    try {
      const response = await fetch("/api/schedules/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        const code: unknown = result?.error?.code;
        const message =
          typeof result?.error?.message === "string"
            ? result.error.message
            : "Could not send the test email";
        if (
          code === "gmail_reconnect_required" ||
          code === "gmail_not_connected"
        )
          setTestError({ text: message, reconnect: true });
        else if (code === "rate_limited")
          setTestError({
            text: rateLimitMessage(message, result?.error?.retry_at),
            reconnect: false,
          });
        else setToast({ tone: "error", text: message });
        return;
      }
      setToast({
        tone: "success",
        text: `Test sent to ${result.sent_to}. Check your inbox.`,
      });
    } catch {
      console.error("[ERROR] test_send_request_failed");
      setToast({
        tone: "error",
        text: "Could not send the test email. Check your connection and try again.",
      });
    } finally {
      setTesting(false);
    }
  }

  const firstSend = nextSends[0] ? sendTimeParts(nextSends[0], timezone) : null;

  return (
    <div className={styles.main}>
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
              <p>Who sends it, who gets it and what it says.</p>
            </div>
            <div className={styles.field}>
              <label htmlFor="sender">From</label>
              <div className={styles.selectWrap}>
                <select
                  id="sender"
                  className={fieldErrors.sender ? styles.invalid : ""}
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  aria-invalid={fieldErrors.sender ? true : undefined}
                  aria-describedby={
                    fieldErrors.sender ? "sender-error" : "sender-hint"
                  }
                >
                  {sender ? null : (
                    <option value="">Choose a Gmail account</option>
                  )}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.status === "connected"
                        ? account.email
                        : `${account.email} (needs reconnect)`}
                    </option>
                  ))}
                </select>
              </div>
              {fieldErrors.sender ? (
                <p id="sender-error" className={styles.fieldError}>
                  {fieldErrors.sender}
                </p>
              ) : (
                <p id="sender-hint" className={styles.hint}>
                  {!sender
                    ? "No sender. Choose a Gmail account."
                    : selectedAccount && selectedAccount.status !== "connected"
                      ? "This account needs reconnecting from your dashboard before it can send."
                      : "Recipients see this address as the sender."}
                </p>
              )}
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
                  onInput={(event) => {
                    bodyEditedRef.current = true;
                    dirtyRef.current = true;
                    setMessageEmpty(!event.currentTarget.innerText.trim());
                  }}
                  onKeyDown={handleEditorKeys}
                />
              </div>
              {fieldErrors.message ? (
                <p id="message-error" className={styles.fieldError}>
                  {fieldErrors.message}
                </p>
              ) : null}
            </div>
            <div className={styles.testSend} data-testid="test-send">
              <div className={styles.testSendRow}>
                <button
                  type="button"
                  className={`${styles.secondary} ${styles.testSendButton}`}
                  onClick={sendTest}
                  disabled={testing}
                  aria-disabled={canSendTest ? undefined : true}
                  aria-busy={testing || undefined}
                  aria-describedby="test-send-hint"
                >
                  {testing ? (
                    <>
                      <span className={styles.spinner} aria-hidden="true" />
                      Sending…
                    </>
                  ) : (
                    "Send me a test"
                  )}
                </button>
                <p id="test-send-hint" className={styles.testSendHint}>
                  {testSender ? (
                    <>
                      We&apos;ll send it to you at <strong>{userEmail}</strong>{" "}
                      from <strong>{testSender.email}</strong>.
                    </>
                  ) : null}
                  {testHint ? (
                    <>
                      {testSender ? " " : ""}
                      {testHint}
                    </>
                  ) : null}
                </p>
              </div>
              {testError ? (
                <p className={styles.testSendError} role="alert">
                  {testError.text}
                  {testError.reconnect ? (
                    <>
                      {" "}
                      <a href="/dashboard">Reconnect Gmail</a>
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="schedule-title">
            <div className={styles.cardHead}>
              <h2 id="schedule-title">Schedule</h2>
              <p>How often it goes out, and when.</p>
            </div>
            {lockedRule ? (
              <div className={styles.locked} data-testid="locked-rule">
                <p className={styles.lockedTitle}>
                  This schedule uses a repeat pattern the editor can&rsquo;t
                  change here.
                </p>
                <p className={styles.lockedSummary}>{summary}</p>
                <p className={styles.hint}>
                  Saving keeps the pattern as it is. To pick a new one, start
                  over with the options below.
                </p>
                <div>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={replaceLockedRule}
                  >
                    Replace with a new schedule
                  </button>
                </div>
              </div>
            ) : (
              <fieldset className={styles.fieldset}>
                <legend className={styles.legend}>Repeat</legend>
                <div className={styles.segmented}>
                  {REPEAT_OPTIONS.map((option) => (
                    <label key={option.value} className={styles.segment}>
                      <input
                        id={`repeat-${option.value}`}
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
            )}
            {!lockedRule && repeat === "weekly" ? (
              <fieldset
                className={styles.fieldset}
                aria-describedby={fieldErrors.days ? "days-error" : undefined}
              >
                <legend className={styles.legend}>Days</legend>
                <DayChips
                  value={selectedDays}
                  onChange={setSelectedDays}
                  invalid={Boolean(fieldErrors.days)}
                />
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
            {!lockedRule && repeat === "monthly" ? (
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
                    {MONTH_DAYS.map((day) => (
                      <option key={day} value={day}>
                        {ordinal(day)}
                      </option>
                    ))}
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
            {!lockedRule && repeat === "custom" ? (
              <div className={styles.builder} data-testid="custom-builder">
                <div className={styles.builderRow}>
                  <label
                    htmlFor="custom-interval"
                    className={styles.builderText}
                  >
                    Every
                  </label>
                  <input
                    id="custom-interval"
                    className={`${styles.numberInput} ${fieldErrors.custom ? styles.invalid : ""}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={999}
                    step={1}
                    aria-label="Repeat every"
                    value={custom.interval > 0 ? custom.interval : ""}
                    onChange={(event) =>
                      updateCustom({
                        interval: Math.min(
                          999,
                          Math.max(0, Math.floor(Number(event.target.value))),
                        ),
                      })
                    }
                    aria-invalid={fieldErrors.custom ? true : undefined}
                    aria-describedby={
                      fieldErrors.custom ? "custom-error" : undefined
                    }
                  />
                  <div className={styles.selectWrap}>
                    <select
                      id="custom-unit"
                      aria-label="Repeat unit"
                      value={custom.unit}
                      onChange={(event) =>
                        updateCustom({
                          unit: event.target.value as IntervalUnit,
                        })
                      }
                    >
                      {INTERVAL_UNITS.map((unit) => (
                        <option key={unit.key} value={unit.key}>
                          {custom.interval === 1 ? unit.singular : unit.plural}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {custom.unit === "weeks" ? (
                  <fieldset
                    className={styles.fieldset}
                    aria-describedby={
                      fieldErrors.days ? "days-error" : undefined
                    }
                  >
                    <legend className={styles.legend}>On</legend>
                    <DayChips
                      value={custom.days}
                      onChange={(days) => updateCustom({ days })}
                      invalid={Boolean(fieldErrors.days)}
                    />
                    {fieldErrors.days ? (
                      <p id="days-error" className={styles.fieldError}>
                        {fieldErrors.days}
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                {custom.unit === "months" ? (
                  <fieldset className={styles.fieldset}>
                    <legend className={styles.legend}>On</legend>
                    <div className={styles.modeRow}>
                      <input
                        id="custom-month-mode-day"
                        type="radio"
                        name="custom-month-mode"
                        value="day"
                        checked={custom.monthlyMode === "day"}
                        onChange={() => updateCustom({ monthlyMode: "day" })}
                      />
                      <label
                        htmlFor="custom-month-mode-day"
                        className={styles.builderText}
                      >
                        day
                      </label>
                      <div className={styles.selectWrap}>
                        <select
                          id="custom-month-day"
                          aria-label="Day of the month"
                          value={custom.monthDay}
                          disabled={custom.monthlyMode !== "day"}
                          onChange={(event) =>
                            updateCustom({
                              monthDay: Number(event.target.value),
                            })
                          }
                        >
                          {MONTH_DAYS.map((day) => (
                            <option key={day} value={day}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className={styles.modeRow}>
                      <input
                        id="custom-month-mode-weekday"
                        type="radio"
                        name="custom-month-mode"
                        value="weekday"
                        checked={custom.monthlyMode === "weekday"}
                        onChange={() =>
                          updateCustom({ monthlyMode: "weekday" })
                        }
                      />
                      <label
                        htmlFor="custom-month-mode-weekday"
                        className={styles.builderText}
                      >
                        the
                      </label>
                      <div className={styles.selectWrap}>
                        <select
                          id="custom-ordinal"
                          aria-label="Week of the month"
                          value={custom.ordinal}
                          disabled={custom.monthlyMode !== "weekday"}
                          onChange={(event) =>
                            updateCustom({
                              ordinal: Number(
                                event.target.value,
                              ) as CustomRule["ordinal"],
                            })
                          }
                        >
                          {ORDINAL_POSITIONS.map((position) => (
                            <option key={position.value} value={position.value}>
                              {position.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.selectWrap}>
                        <select
                          id="custom-weekday"
                          aria-label="Weekday"
                          value={custom.weekday}
                          disabled={custom.monthlyMode !== "weekday"}
                          onChange={(event) =>
                            updateCustom({
                              weekday: event.target.value as Weekday,
                            })
                          }
                        >
                          {WEEKDAYS.map((day) => (
                            <option key={day.key} value={day.key}>
                              {day.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {custom.monthlyMode === "day" && custom.monthDay > 28 ? (
                      <p className={styles.hint}>
                        Months without a {ordinal(custom.monthDay)} are skipped.
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
                {custom.unit === "years" ? (
                  <fieldset className={styles.fieldset}>
                    <legend className={styles.legend}>On</legend>
                    <div className={styles.builderRow}>
                      <div className={styles.selectWrap}>
                        <select
                          id="custom-month"
                          aria-label="Month"
                          value={custom.month}
                          onChange={(event) =>
                            updateCustom({
                              month: Number(event.target.value),
                            })
                          }
                        >
                          {MONTH_NAMES.map((name, index) => (
                            <option key={name} value={index + 1}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.selectWrap}>
                        <select
                          id="custom-month-day"
                          aria-label="Day of the month"
                          value={custom.monthDay}
                          onChange={(event) =>
                            updateCustom({
                              monthDay: Number(event.target.value),
                            })
                          }
                        >
                          {MONTH_DAYS.map((day) => (
                            <option key={day} value={day}>
                              {day}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </fieldset>
                ) : null}
                <fieldset className={styles.fieldset}>
                  <legend className={styles.legend}>Ends</legend>
                  <div className={styles.builderRow}>
                    <div className={styles.selectWrap}>
                      <select
                        id="custom-ends"
                        aria-label="Ends"
                        value={custom.ends}
                        onChange={(event) =>
                          updateCustom({
                            ends: event.target.value as CustomRule["ends"],
                          })
                        }
                      >
                        <option value="never">Never</option>
                        <option value="on">On</option>
                        <option value="after">After</option>
                      </select>
                    </div>
                    {custom.ends === "on" ? (
                      <input
                        id="custom-end-date"
                        className={styles.dateInput}
                        type="date"
                        aria-label="End date"
                        value={custom.endDate}
                        onChange={(event) =>
                          updateCustom({ endDate: event.target.value })
                        }
                      />
                    ) : null}
                    {custom.ends === "after" ? (
                      <>
                        <input
                          id="custom-end-count"
                          className={styles.numberInput}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={999}
                          step={1}
                          aria-label="Number of sends"
                          value={custom.endCount > 0 ? custom.endCount : ""}
                          onChange={(event) =>
                            updateCustom({
                              endCount: Math.min(
                                999,
                                Math.max(
                                  0,
                                  Math.floor(Number(event.target.value)),
                                ),
                              ),
                            })
                          }
                        />
                        <span className={styles.builderText}>
                          {custom.endCount === 1 ? "send" : "sends"}
                        </span>
                      </>
                    ) : null}
                  </div>
                </fieldset>
                {fieldErrors.custom ? (
                  <p id="custom-error" className={styles.fieldError}>
                    {fieldErrors.custom}
                  </p>
                ) : null}
              </div>
            ) : null}
            {lockedRule ? null : (
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
            )}

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
                        <span className={styles.tileMonth}>{parts.month}</span>
                        <strong className={styles.tileDay}>{parts.day}</strong>
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
                  Finish the repeat pattern and time zone to preview send times.
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
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  );
}
