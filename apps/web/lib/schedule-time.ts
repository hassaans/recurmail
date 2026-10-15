// Shared schedule time formatting. Every schedule time is shown in the
// schedule's own IANA timezone with a short zone label, never in the
// browser's or server's zone.

// Fallback labels for zones whose Intl short name is only a numeric offset in
// every locale we try. The date-aware Intl lookup always runs first so a zone
// that observes daylight saving (Cairo, for example) keeps its seasonal label.
const fixedZoneLabels: Record<string, string> = {
  "Asia/Karachi": "PKT",
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
  "Asia/Colombo": "IST",
  "Asia/Dhaka": "BST",
  "Asia/Kathmandu": "NPT",
  "Asia/Dubai": "GST",
  "Asia/Riyadh": "AST",
  "Asia/Singapore": "SGT",
  "Asia/Kuala_Lumpur": "MYT",
  "Asia/Jakarta": "WIB",
  "Asia/Bangkok": "ICT",
  "Asia/Ho_Chi_Minh": "ICT",
  "Asia/Manila": "PHT",
  "Asia/Hong_Kong": "HKT",
  "Asia/Shanghai": "CST",
  "Asia/Taipei": "CST",
  "Asia/Seoul": "KST",
  "Asia/Tokyo": "JST",
  "Africa/Lagos": "WAT",
  "Africa/Nairobi": "EAT",
  "Africa/Johannesburg": "SAST",
  "America/Sao_Paulo": "BRT",
  "America/Argentina/Buenos_Aires": "ART",
};

// en-US names North American zones (EDT, PST); the other locales name
// their own regions (BST, CEST, AEDT, IST). The first non-numeric answer wins.
const labelLocales = ["en-US", "en-GB", "en-AU", "en-IN", "en-NZ"];

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function zonePart(date: Date, timezone: string, locale: string): string {
  return (
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Short zone label for a moment in a timezone, e.g. "PKT", "EDT", "UTC". */
export function zoneLabel(timezone: string, at: string | Date): string {
  const date = toDate(at) ?? new Date();
  if (!isValidTimezone(timezone)) return "UTC";
  let numeric = "";
  for (const locale of labelLocales) {
    const label = zonePart(date, timezone, locale);
    if (!label) continue;
    if (!/^(GMT|UTC)[+-]/.test(label)) return label;
    if (!numeric) numeric = label;
  }
  return fixedZoneLabels[timezone] ?? (numeric || timezone);
}

function clockParts(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** "6:25 AM" in the schedule's zone, without the zone label. */
export function formatClock(value: string | Date, timezone: string): string {
  const date = toDate(value);
  if (!date || !isValidTimezone(timezone)) return "Time unavailable";
  return clockParts(date, timezone);
}

/** "6:25 AM PKT" in the schedule's zone. */
export function formatClockWithZone(
  value: string | Date,
  timezone: string,
): string {
  const date = toDate(value);
  if (!date || !isValidTimezone(timezone)) return "Time unavailable";
  return `${clockParts(date, timezone)} ${zoneLabel(timezone, date)}`;
}

/**
 * "Fri, Oct 16 at 6:25 AM PKT" in the schedule's zone. The year is added
 * only when the moment is not in the current year.
 */
export function formatScheduleTime(
  value: string | Date,
  timezone: string,
  options: { year?: boolean | "auto" } = {},
): string {
  const date = toDate(value);
  if (!date || !isValidTimezone(timezone)) return "Time unavailable";
  const year = options.year ?? "auto";
  const showYear =
    year === "auto"
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
        }).format(date) !==
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
        }).format(new Date())
      : year;
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  }).format(date);
  return `${day} at ${clockParts(date, timezone)} ${zoneLabel(timezone, date)}`;
}

/** True when both moments fall in the same minute of the given zone. */
export function sameMinute(
  first: string | Date,
  second: string | Date,
): boolean {
  const a = toDate(first);
  const b = toDate(second);
  if (!a || !b) return false;
  return Math.floor(a.getTime() / 60000) === Math.floor(b.getTime() / 60000);
}

const weekdayNames: Record<string, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

function ruleFields(rule: string): Record<string, string> {
  const content = rule.match(/(?:^|\n)RRULE:([^\n]+)/)?.[1] ?? rule;
  return Object.fromEntries(
    content.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key?.toUpperCase() ?? "", value ?? ""];
    }),
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Plain-language cadence without a time: "Every week on Monday and Friday". */
export function repeatSummary(rule: string): string {
  const fields = ruleFields(rule);
  const interval = Number(fields.INTERVAL || "1");
  const every = (unit: string) =>
    interval > 1 ? `Every ${interval} ${unit}s` : `Every ${unit}`;
  if (fields.FREQ === "DAILY") return interval > 1 ? every("day") : "Every day";
  if (fields.FREQ === "WEEKLY") {
    const days = (fields.BYDAY || "")
      .split(",")
      .map((day) => weekdayNames[day.replace(/^[+-]?\d+/, "")])
      .filter((name): name is string => Boolean(name));
    const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    const isWeekdays =
      days.length === 5 && weekdays.every((name) => days.includes(name));
    if (isWeekdays && interval === 1) return "Every weekday";
    const cadence = interval > 1 ? every("week") : "Every week";
    return days.length ? `${cadence} on ${joinNames(days)}` : cadence;
  }
  if (fields.FREQ === "MONTHLY") {
    const cadence = interval > 1 ? every("month") : "Every month";
    return fields.BYMONTHDAY
      ? `${cadence} on day ${fields.BYMONTHDAY}`
      : cadence;
  }
  if (fields.FREQ === "YEARLY")
    return interval > 1 ? every("year") : "Every year";
  return "Custom recurring schedule";
}

/** Short label for a card strip: "Daily", "Weekly", "Monthly", "Custom". */
export function repeatLabel(rule: string): string {
  const fields = ruleFields(rule);
  const interval = Number(fields.INTERVAL || "1");
  if (fields.FREQ === "DAILY")
    return interval > 1 ? `Every ${interval} days` : "Daily";
  if (fields.FREQ === "WEEKLY") {
    if (interval > 1) return `Every ${interval} weeks`;
    const days = (fields.BYDAY || "").split(",").filter(Boolean);
    return days.length === 5 && !days.some((day) => /SA|SU/.test(day))
      ? "Weekdays"
      : "Weekly";
  }
  if (fields.FREQ === "MONTHLY")
    return interval > 1 ? `Every ${interval} months` : "Monthly";
  if (fields.FREQ === "YEARLY") return "Yearly";
  return "Custom";
}

/**
 * Plain-language cadence with the send time in the schedule's zone:
 * "Every day at 6:25 AM". The clock comes from the rule's BYHOUR/BYMINUTE
 * (which are expressed in the schedule's zone) and falls back to the next
 * send when the rule has no clock.
 */
export function describeCadence(
  rule: string,
  timezone: string,
  nextSendAt?: string | Date,
): string {
  const summary = repeatSummary(rule);
  const fields = ruleFields(rule);
  const hour = Number(fields.BYHOUR);
  const minute = Number(fields.BYMINUTE || "0");
  if (
    fields.BYHOUR !== undefined &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour < 24 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute < 60 &&
    !fields.BYHOUR.includes(",") &&
    !(fields.BYMINUTE || "").includes(",")
  ) {
    const clock = new Date(Date.UTC(2026, 0, 1, hour, minute));
    return `${summary} at ${clockParts(clock, "UTC")}`;
  }
  if (nextSendAt !== undefined) {
    const date = toDate(nextSendAt);
    if (date && isValidTimezone(timezone))
      return `${summary} at ${clockParts(date, timezone)}`;
  }
  return summary;
}
