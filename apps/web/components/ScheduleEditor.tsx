"use client";

import { nextOccurrence, presets, type Weekday } from "@recurmail/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./ScheduleEditor.module.css";

type Repeat = "daily" | "weekdays" | "weekly" | "monthly" | "custom";
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

const days: { key: Weekday; name: string }[] = [
  { key: "MO", name: "Monday" },
  { key: "TU", name: "Tuesday" },
  { key: "WE", name: "Wednesday" },
  { key: "TH", name: "Thursday" },
  { key: "FR", name: "Friday" },
  { key: "SA", name: "Saturday" },
  { key: "SU", name: "Sunday" },
];

function splitAddresses(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseRule(rule: string): Record<string, string> {
  const line =
    rule.split(/\r?\n/).find((part) => /^RRULE:/i.test(part)) ?? rule;
  return Object.fromEntries(
    line
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((field) => {
        const [key, value] = field.split("=", 2);
        return [key?.toUpperCase(), value ?? ""];
      }),
  );
}

function repeatFromRule(rule: string): Repeat {
  const fields = parseRule(rule);
  if (fields.FREQ === "DAILY") return "daily";
  if (fields.FREQ === "MONTHLY" && fields.BYMONTHDAY) return "monthly";
  if (fields.FREQ === "WEEKLY") {
    return fields.BYDAY === "MO,TU,WE,TH,FR" ? "weekdays" : "weekly";
  }
  return "custom";
}

function localTimeFromRule(rule: string): string {
  const fields = parseRule(rule);
  const hour = (fields.BYHOUR ?? "9").padStart(2, "0");
  const minute = (fields.BYMINUTE ?? "0").padStart(2, "0");
  return `${hour}:${minute}`;
}

function readableDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);
}

export default function ScheduleEditor({
  scheduleId,
}: {
  scheduleId?: string;
}) {
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [subject, setSubject] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("weekly");
  const [selectedDays, setSelectedDays] = useState<Weekday[]>(["MO"]);
  const [monthDay, setMonthDay] = useState(1);
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState("UTC");
  const [customRule, setCustomRule] = useState("FREQ=DAILY");
  const [loading, setLoading] = useState(Boolean(scheduleId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [bodyContent, setBodyContent] = useState<{
    html: string | null;
    text: string;
  } | null>(null);

  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  useEffect(() => {
    if (loading || !bodyContent || !bodyRef.current) return;
    bodyRef.current.innerHTML = bodyContent.html ?? "";
    if (!bodyContent.html) bodyRef.current.textContent = bodyContent.text;
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
        setTo(existing.to.join(", "));
        setCc(existing.cc.join(", "));
        setBcc(existing.bcc.join(", "));
        setTimezone(existing.timezone);
        setRepeat(repeatFromRule(existing.rrule));
        setTime(localTimeFromRule(existing.rrule));
        const fields = parseRule(existing.rrule);
        if (fields.BYDAY) setSelectedDays(fields.BYDAY.split(",") as Weekday[]);
        if (fields.BYMONTHDAY) setMonthDay(Number(fields.BYMONTHDAY));
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
      if (repeat === "weekdays") return presets.weekdays(clock);
      if (repeat === "weekly") return presets.weekly(selectedDays, clock);
      return presets.monthly(monthDay, clock);
    } catch {
      return "";
    }
  }, [customRule, monthDay, repeat, selectedDays, time]);

  const nextSends = useMemo(() => {
    if (!rrule) return [];
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

  function format(
    command:
      | "bold"
      | "italic"
      | "insertUnorderedList"
      | "insertOrderedList"
      | "createLink",
  ) {
    if (command === "createLink") {
      const url = window.prompt("Link URL (http, https or mailto)");
      if (!url) return;
      document.execCommand(command, false, url);
    } else {
      document.execCommand(command);
    }
    bodyRef.current?.focus();
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setWarning("");
    if (!rrule) {
      setError("Choose a valid repeat pattern and time.");
      return;
    }
    const bodyHtml = bodyRef.current?.innerHTML ?? "";
    const bodyText = bodyRef.current?.innerText ?? "";
    const payload = {
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      to: splitAddresses(to),
      cc: splitAddresses(cc),
      bcc: splitAddresses(bcc),
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
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#editor">
        Skip to schedule editor
      </a>
      <header className={styles.header}>
        <a className={styles.logo} href="/dashboard">
          RecurMail
        </a>
        <a href="/dashboard">Dashboard</a>
      </header>
      <main id="editor" className={styles.main}>
        <p className={styles.eyebrow}>Set up a repeating email.</p>
        <h1>{scheduleId ? "Edit schedule" : "New schedule"}</h1>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {warning ? (
          <p className={styles.warning} role="status">
            {warning}
          </p>
        ) : null}
        {loading ? (
          <p role="status">Loading schedule…</p>
        ) : (
          <form className={styles.form} onSubmit={save}>
            <section className={styles.card} aria-labelledby="message-title">
              <h2 id="message-title">Email</h2>
              <div className={styles.field}>
                <label htmlFor="to">To</label>
                <input
                  id="to"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  required
                  placeholder="name@example.com"
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="cc">Cc</label>
                <input
                  id="cc"
                  value={cc}
                  onChange={(event) => setCc(event.target.value)}
                  placeholder="Separate addresses with commas"
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="bcc">Bcc</label>
                <input
                  id="bcc"
                  value={bcc}
                  onChange={(event) => setBcc(event.target.value)}
                  placeholder="Separate addresses with commas"
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="subject">Subject</label>
                <input
                  id="subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  required
                  maxLength={998}
                />
              </div>
              <label htmlFor="message">Message</label>
              <div
                className={styles.toolbar}
                role="toolbar"
                aria-label="Message formatting"
              >
                <button
                  type="button"
                  aria-label="Bold"
                  onClick={() => format("bold")}
                >
                  <strong>B</strong>
                </button>
                <button
                  type="button"
                  aria-label="Italic"
                  onClick={() => format("italic")}
                >
                  <em>I</em>
                </button>
                <button
                  type="button"
                  aria-label="Insert link"
                  onClick={() => format("createLink")}
                >
                  Link
                </button>
                <button
                  type="button"
                  aria-label="Bulleted list"
                  onClick={() => format("insertUnorderedList")}
                >
                  • List
                </button>
                <button
                  type="button"
                  aria-label="Numbered list"
                  onClick={() => format("insertOrderedList")}
                >
                  1. List
                </button>
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: a contenteditable region provides rich text editing */}
              <div
                id="message"
                ref={bodyRef}
                className={styles.body}
                role="textbox"
                aria-label="Message"
                aria-multiline="true"
                tabIndex={0}
                contentEditable
                suppressContentEditableWarning
              />
            </section>
            <section className={styles.card} aria-labelledby="repeat-title">
              <h2 id="repeat-title">Repeat</h2>
              <div className={styles.field}>
                <label htmlFor="repeat">Repeat</label>
                <select
                  id="repeat"
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value as Repeat)}
                >
                  <option value="daily">Daily</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom RRULE</option>
                </select>
              </div>
              {repeat === "weekly" ? (
                <fieldset className={styles.days}>
                  <legend>Days of the week</legend>
                  {days.map((day) => (
                    <label key={day.key}>
                      <input
                        type="checkbox"
                        checked={selectedDays.includes(day.key)}
                        onChange={(event) =>
                          setSelectedDays((current) =>
                            event.target.checked
                              ? [...current, day.key]
                              : current.filter((item) => item !== day.key),
                          )
                        }
                      />
                      {day.name}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {repeat === "monthly" ? (
                <div className={styles.field}>
                  <label htmlFor="month-day">Date of month</label>
                  <select
                    id="month-day"
                    value={monthDay}
                    onChange={(event) =>
                      setMonthDay(Number(event.target.value))
                    }
                  >
                    {Array.from({ length: 31 }, (_, index) => index + 1).map(
                      (day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ),
                    )}
                  </select>
                </div>
              ) : null}
              {repeat === "custom" ? (
                <div className={styles.field}>
                  <label htmlFor="custom-rule">Custom RRULE</label>
                  <textarea
                    id="custom-rule"
                    value={customRule}
                    onChange={(event) => setCustomRule(event.target.value)}
                    rows={3}
                  />
                </div>
              ) : null}
              <div className={styles.field}>
                <label htmlFor="time">Time</label>
                <input
                  id="time"
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="timezone">IANA timezone</label>
                <input
                  id="timezone"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                />
              </div>
              <h3>Next 5 send times</h3>
              <ol className={styles.preview} data-testid="next-send-preview">
                {nextSends.length ? (
                  nextSends.map((date) => (
                    <li key={date.toISOString()}>
                      {readableDate(date, timezone)}
                    </li>
                  ))
                ) : (
                  <li>Enter a valid repeat pattern and timezone to preview.</li>
                )}
              </ol>
            </section>
            <div className={styles.actions}>
              <a href="/dashboard">Cancel</a>
              <button
                className={styles.save}
                type="submit"
                disabled={saving || loading}
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
