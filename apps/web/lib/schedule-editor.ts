import type { Weekday } from "@recurmail/core";

// Pure helpers for the schedule editor. Nothing here touches the DOM, so the
// editor can render on the server and the helpers can run under vitest.

export type Repeat = "daily" | "weekly" | "monthly" | "custom";

export const WEEKDAYS: { key: Weekday; name: string; letter: string }[] = [
  { key: "MO", name: "Monday", letter: "M" },
  { key: "TU", name: "Tuesday", letter: "T" },
  { key: "WE", name: "Wednesday", letter: "W" },
  { key: "TH", name: "Thursday", letter: "T" },
  { key: "FR", name: "Friday", letter: "F" },
  { key: "SA", name: "Saturday", letter: "S" },
  { key: "SU", name: "Sunday", letter: "S" },
];

const WEEKDAY_ORDER: Weekday[] = WEEKDAYS.map((day) => day.key);
const SHORT_TO_KEY: Record<string, Weekday> = {
  Mon: "MO",
  Tue: "TU",
  Wed: "WE",
  Thu: "TH",
  Fri: "FR",
  Sat: "SA",
  Sun: "SU",
};

/** Split pasted or typed text into candidate addresses, keeping first-seen order. */
export function splitAddresses(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const item = raw.trim().replace(/^<|>$/g, "");
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Mirror of the server's recipient check so bad chips are flagged before save. */
export function isValidAddress(email: string): boolean {
  if (/[\r\n]/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || email.length > 254) return false;
  const [local, domain] = parts;
  if (
    local.length === 0 ||
    local.length > 64 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return false;
  }
  return domain
    .split(".")
    .every((label) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
    );
}

export function parseRule(rule: string): Record<string, string> {
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

/** Which editor mode an existing RRULE maps to. Weekday-only rules load as weekly. */
export function repeatFromRule(rule: string): Repeat {
  const fields = parseRule(rule);
  const extra = Object.keys(fields).filter(
    (key) =>
      ![
        "FREQ",
        "BYDAY",
        "BYMONTHDAY",
        "BYHOUR",
        "BYMINUTE",
        "BYSECOND",
      ].includes(key),
  );
  if (extra.length > 0 || /DTSTART/i.test(rule)) return "custom";
  if (fields.FREQ === "DAILY" && !fields.BYDAY && !fields.BYMONTHDAY)
    return "daily";
  if (fields.FREQ === "MONTHLY" && fields.BYMONTHDAY && !fields.BYDAY)
    return "monthly";
  if (fields.FREQ === "WEEKLY" && fields.BYDAY && !fields.BYMONTHDAY) {
    const days = fields.BYDAY.split(",");
    if (days.every((day) => WEEKDAY_ORDER.includes(day as Weekday)))
      return "weekly";
  }
  return "custom";
}

export function weekdaysFromRule(rule: string): Weekday[] {
  const byDay = parseRule(rule).BYDAY;
  if (!byDay) return [];
  return WEEKDAY_ORDER.filter((day) => byDay.split(",").includes(day));
}

export function localTimeFromRule(rule: string): string {
  const fields = parseRule(rule);
  const hour = (fields.BYHOUR ?? "9").padStart(2, "0");
  const minute = (fields.BYMINUTE ?? "0").padStart(2, "0");
  return `${hour}:${minute}`;
}

export function sortWeekdays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAY_ORDER.filter((day) => days.includes(day));
}

/** "09:05" → "9:05 AM". Invalid input is returned unchanged. */
export function formatClock(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = match[2];
  if (hour > 23 || Number(minute) > 59) return time;
  const suffix = hour < 12 ? "AM" : "PM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${minute} ${suffix}`;
}

export function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[(day % 10) as 1 | 2 | 3] ?? "th";
  return `${day}${suffix}`;
}

export function isKnownTimeZone(id: string): boolean {
  if (!id || !/^[A-Za-z0-9_+\-/]+$/.test(id)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/** Minutes east of UTC for `id` at the instant `at`, or null for unknown zones. */
export function timeZoneOffsetMinutes(id: string, at: Date): number | null {
  if (!isKnownTimeZone(id)) return null;
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((item) => item.type === "timeZoneName")?.value;
  if (!part) return null;
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(part);
  if (!match) return null;
  if (!match[1]) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

/** "UTC+5", "UTC-4", "UTC+5:30", "UTC+0". */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return "UTC+0";
  const sign = minutes < 0 ? "-" : "+";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

function cityFromId(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/_/g, " ");
}

/**
 * Friendly region name without the Standard/Daylight qualifier, for example
 * "Pakistan Time" or "Eastern Time". Zones that only have a GMT offset name fall
 * back to the city in the IANA id.
 */
export function timeZoneRegionName(id: string, at: Date): string {
  if (!isKnownTimeZone(id)) return id;
  if (id === "UTC" || id === "Etc/UTC") return "Coordinated Universal Time";
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    timeZoneName: "long",
  })
    .formatToParts(at)
    .find((item) => item.type === "timeZoneName")?.value;
  if (!part || /^GMT[+-]?/.test(part)) return cityFromId(id);
  return part.replace(/\b(Standard|Daylight|Summer) /, "");
}

/** "Pakistan Time (Asia/Karachi), UTC+5". Unknown zones return the raw id. */
export function timeZoneLabel(id: string, at: Date = new Date()): string {
  const offset = timeZoneOffsetMinutes(id, at);
  if (offset === null) return id;
  return `${timeZoneRegionName(id, at)} (${id}), ${formatUtcOffset(offset)}`;
}

export interface TimeZoneOption {
  id: string;
  label: string;
  offsetMinutes: number;
  /** Lower-cased text used for substring search: label, id, and the city with spaces. */
  search: string;
  /** Lower-cased region name ("pakistan time") and city ("karachi") for ranking. */
  region: string;
  city: string;
}

function buildOption(id: string, at: Date): TimeZoneOption | null {
  const offsetMinutes = timeZoneOffsetMinutes(id, at);
  if (offsetMinutes === null) return null;
  const label = timeZoneLabel(id, at);
  const city = cityFromId(id);
  return {
    id,
    label,
    offsetMinutes,
    search: `${label} ${id} ${city}`.toLowerCase(),
    region: timeZoneRegionName(id, at).toLowerCase(),
    city: city.toLowerCase(),
  };
}

function sortOptions(options: TimeZoneOption[]): TimeZoneOption[] {
  return options.sort(
    (a, b) => a.offsetMinutes - b.offsetMinutes || a.id.localeCompare(b.id),
  );
}

function supportedTimeZoneIds(): string[] {
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  const ids = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  const set = new Set(ids.filter(isKnownTimeZone));
  set.add("UTC");
  return [...set];
}

/** Every zone the runtime knows, sorted west to east then by name. */
export function timeZoneOptions(at: Date = new Date()): TimeZoneOption[] {
  const options: TimeZoneOption[] = [];
  for (const id of supportedTimeZoneIds()) {
    const option = buildOption(id, at);
    if (option) options.push(option);
  }
  return sortOptions(options);
}

/**
 * Add `id` to the list when the runtime knows the zone but did not list it, for
 * example a schedule saved as Asia/Kolkata viewed in a browser that lists
 * Asia/Calcutta. Returns the same array when nothing is missing.
 */
export function ensureTimeZoneOption(
  options: readonly TimeZoneOption[],
  id: string,
  at: Date = new Date(),
): TimeZoneOption[] {
  if (options.some((option) => option.id === id)) return [...options];
  const added = buildOption(id, at);
  if (!added) return [...options];
  return sortOptions([...options, added]);
}

/**
 * Case-insensitive match over every word the user typed. Exact id matches and
 * region or city names that start with the query rank first, so typing "utc"
 * lists UTC before every zone whose offset label mentions UTC.
 */
export function filterTimeZones(
  options: readonly TimeZoneOption[],
  query: string,
): TimeZoneOption[] {
  const trimmed = query.trim().toLowerCase();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  const rank = (option: TimeZoneOption): number => {
    if (option.id.toLowerCase() === trimmed) return 0;
    if (option.region.startsWith(trimmed) || option.city.startsWith(trimmed))
      return 1;
    if (option.id.toLowerCase().includes(trimmed)) return 2;
    return 3;
  };
  return options
    .filter((option) => words.every((word) => option.search.includes(word)))
    .map((option, index) => ({ option, index, rank: rank(option) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.option);
}

export interface ScheduleDefaults {
  weekday: Weekday;
  time: string;
}

/**
 * The next whole hour in `timeZone` after `now`, and the weekday that hour
 * falls on. 23:xx rolls over to 00:00 the next day.
 */
export function scheduleDefaults(
  now: Date,
  timeZone: string,
): ScheduleDefaults {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hourText = parts.find((part) => part.type === "hour")?.value ?? "0";
  const weekdayText = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(hourText) % 24;
  let weekday = SHORT_TO_KEY[weekdayText ?? ""] ?? "MO";
  let nextHour = hour + 1;
  if (nextHour === 24) {
    nextHour = 0;
    const index = WEEKDAY_ORDER.indexOf(weekday);
    weekday = WEEKDAY_ORDER[(index + 1) % 7];
  }
  return { weekday, time: `${String(nextHour).padStart(2, "0")}:00` };
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface SummaryInput {
  repeat: Repeat;
  days: readonly Weekday[];
  monthDay: number;
  time: string;
  timeZone: string;
  at?: Date;
}

/** One-line description such as "Every Monday at 9:00 AM, Pakistan Time". */
export function describeSchedule(input: SummaryInput): string {
  const clock = formatClock(input.time);
  const zone = timeZoneRegionName(input.timeZone, input.at ?? new Date());
  const tail = `at ${clock}, ${zone}`;
  if (input.repeat === "daily") return `Every day ${tail}`;
  if (input.repeat === "monthly")
    return `On the ${ordinal(input.monthDay)} of every month ${tail}`;
  if (input.repeat === "custom") return `Custom rule ${tail}`;
  const days = sortWeekdays(input.days);
  if (days.length === 0) return "Pick at least one day";
  if (days.length === 7) return `Every day ${tail}`;
  if (days.join(",") === "MO,TU,WE,TH,FR") return `Every weekday ${tail}`;
  const names = days.map(
    (key) => WEEKDAYS.find((day) => day.key === key)?.name ?? key,
  );
  return `Every ${listNames(names)} ${tail}`;
}

export interface SendTimeParts {
  weekday: string;
  day: string;
  month: string;
  time: string;
  year: string;
}

/** Parts of an instant in the schedule's zone for the next-sends list. */
export function sendTimeParts(date: Date, timeZone: string): SendTimeParts {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dayPeriod = read("dayPeriod");
  return {
    weekday: read("weekday"),
    day: read("day"),
    month: read("month"),
    year: read("year"),
    time: `${read("hour")}:${read("minute")}${dayPeriod ? ` ${dayPeriod}` : ""}`,
  };
}
