import type { Weekday } from "@recurmail/core";
import {
  ABBREVIATIONS,
  CANONICAL_TO_LEGACY,
  CITY_ZONES,
  COMMON_TIME_ZONES,
  COUNTRY_ZONES,
  LEGACY_ZONE_IDS,
} from "./time-zone-aliases";

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
  // Several send times a day cannot be shown in one time field.
  if (
    [fields.BYHOUR, fields.BYMINUTE, fields.BYSECOND].some((value) =>
      value?.includes(","),
    )
  )
    return "custom";
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
  /**
   * Lower-cased text used for substring search: label, id, city, and every
   * alias (abbreviations, country names, well-known cities, legacy ids).
   */
  search: string;
  /** Lower-cased region name ("pakistan time") and city ("karachi") for ranking. */
  region: string;
  city: string;
  /** Lower-cased aliases this zone matches, for example "pkt" or "lahore". */
  terms: string[];
  /** The subset of `terms` for which this zone is the first answer. */
  primaryTerms: string[];
}

/** The canonical IANA id for `id`, or `id` itself when it is not a legacy name. */
export function canonicalTimeZoneId(id: string): string {
  return LEGACY_ZONE_IDS[id] ?? id;
}

/** Ids that refer to the same zone as `id`: itself plus its legacy or canonical twin. */
function equivalentIds(id: string): string[] {
  const ids = new Set([id]);
  const canonical = LEGACY_ZONE_IDS[id];
  if (canonical) ids.add(canonical);
  const legacy = CANONICAL_TO_LEGACY[id];
  if (legacy) ids.add(legacy);
  return [...ids];
}

interface AliasIndex {
  byName: Map<string, { abbreviation: string; primary: readonly string[] }[]>;
  byZone: Map<string, { term: string; primary: boolean }[]>;
}

let aliasIndex: AliasIndex | null = null;

/** Lazily inverted alias tables keyed by zone id and by Intl long name. */
function getAliasIndex(): AliasIndex {
  if (aliasIndex) return aliasIndex;
  const byName: AliasIndex["byName"] = new Map();
  const byZone: AliasIndex["byZone"] = new Map();
  const add = (zone: string, term: string, primary: boolean) => {
    const list = byZone.get(zone) ?? [];
    list.push({ term: term.toLowerCase(), primary });
    byZone.set(zone, list);
  };
  for (const [abbreviation, entry] of Object.entries(ABBREVIATIONS)) {
    for (const name of entry.names) {
      const list = byName.get(name) ?? [];
      list.push({ abbreviation, primary: entry.primary });
      byName.set(name, list);
    }
    // The first answer for an abbreviation must not depend on how the runtime
    // names the zone: Chromium's ICU calls Europe/London "GMT+00:00" in winter
    // rather than "Greenwich Mean Time", which would otherwise drop "GMT".
    for (const zone of entry.primary) add(zone, abbreviation, true);
  }
  for (const [names, zones] of COUNTRY_ZONES) {
    zones.forEach((zone, index) => {
      for (const name of names) add(zone, name, index === 0);
    });
  }
  for (const [names, zones] of CITY_ZONES) {
    zones.forEach((zone, index) => {
      for (const name of names) add(zone, name, index === 0);
    });
  }
  aliasIndex = { byName, byZone };
  return aliasIndex;
}

function longZoneName(id: string, at: Date): string | null {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: id,
    timeZoneName: "long",
  })
    .formatToParts(at)
    .find((item) => item.type === "timeZoneName")?.value;
  return part && !/^GMT[+-]?/.test(part) ? part : null;
}

function buildOption(id: string, at: Date): TimeZoneOption | null {
  const offsetMinutes = timeZoneOffsetMinutes(id, at);
  if (offsetMinutes === null) return null;
  const label = timeZoneLabel(id, at);
  const city = cityFromId(id);
  const index = getAliasIndex();
  const ids = equivalentIds(id);
  const terms = new Map<string, boolean>();
  const addTerm = (term: string, primary: boolean) => {
    terms.set(term, (terms.get(term) ?? false) || primary);
  };
  for (const twin of ids) {
    if (twin !== id) addTerm(twin.toLowerCase(), true);
    for (const alias of index.byZone.get(twin) ?? []) {
      addTerm(alias.term, alias.primary);
    }
  }
  const year = at.getUTCFullYear();
  const names = new Set<string>();
  for (const month of [0, 6]) {
    const name = longZoneName(id, new Date(Date.UTC(year, month, 15, 12)));
    if (name) names.add(name);
  }
  for (const name of names) {
    for (const entry of index.byName.get(name) ?? []) {
      addTerm(
        entry.abbreviation.toLowerCase(),
        entry.primary.some((zone) => ids.includes(zone)),
      );
    }
  }
  const allTerms = [...terms.keys()];
  return {
    id,
    label,
    offsetMinutes,
    search: [label, id, city, ...allTerms].join(" ").toLowerCase(),
    region: timeZoneRegionName(id, at).toLowerCase(),
    city: city.toLowerCase(),
    terms: allTerms,
    primaryTerms: allTerms.filter((term) => terms.get(term)),
  };
}

function sortOptions(options: TimeZoneOption[]): TimeZoneOption[] {
  return options.sort(
    (a, b) => a.offsetMinutes - b.offsetMinutes || a.id.localeCompare(b.id),
  );
}

/**
 * Every zone the runtime lists, under its canonical IANA id. Chromium and Node
 * still list legacy names such as Asia/Calcutta, Asia/Saigon and Europe/Kiev,
 * so each id is mapped and the list deduplicated before any option is built.
 * Ids the runtime cannot format are dropped.
 */
function supportedTimeZoneIds(): string[] {
  const intl = Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  };
  const ids = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  const set = new Set(ids.map(canonicalTimeZoneId).filter(isKnownTimeZone));
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
 * Case-insensitive match over every word the user typed, against the label,
 * id, city and aliases (abbreviations such as PKT, country names, well-known
 * cities such as Lahore). Ranking, best first: the exact id; the zone an alias
 * names first ("PKT" → Asia/Karachi, "United States" → America/New_York);
 * region, city or alias prefixes; ids containing the text; everything else.
 */
export function filterTimeZones(
  options: readonly TimeZoneOption[],
  query: string,
): TimeZoneOption[] {
  const trimmed = query.trim().toLowerCase().replace(/\s+/g, " ");
  const words = trimmed.split(" ").filter(Boolean);
  if (words.length === 0) return [...options];
  const rank = (option: TimeZoneOption): number => {
    const id = option.id.toLowerCase();
    if (id === trimmed || option.terms.includes(trimmed)) {
      if (id === trimmed) return 0;
      if (option.primaryTerms.includes(trimmed)) return 1;
      return 2;
    }
    if (
      option.region.startsWith(trimmed) ||
      option.city.startsWith(trimmed) ||
      option.terms.some((term) => term.startsWith(trimmed))
    )
      return 2;
    if (id.includes(trimmed)) return 3;
    return 4;
  };
  return options
    .filter((option) => words.every((word) => option.search.includes(word)))
    .map((option, index) => ({ option, index, rank: rank(option) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.option);
}

/** The option for `id`, accepting a legacy or canonical twin of the id. */
export function findTimeZoneOption(
  options: readonly TimeZoneOption[],
  id: string,
): TimeZoneOption | undefined {
  const ids = equivalentIds(id);
  return (
    options.find((option) => option.id === id) ??
    options.find((option) => ids.includes(option.id))
  );
}

export interface TimeZoneGroup {
  name: "Suggested" | "Common" | "All";
  options: TimeZoneOption[];
}

/**
 * Groups for the opened picker: the current selection and the browser zone,
 * then common zones, then every zone. The current selection is always the
 * first option of the first group.
 */
export function groupTimeZones(
  options: readonly TimeZoneOption[],
  current: string,
  browserZone: string | null,
): TimeZoneGroup[] {
  const suggested: TimeZoneOption[] = [];
  for (const id of [current, browserZone ?? ""]) {
    const option = id ? findTimeZoneOption(options, id) : undefined;
    if (option && !suggested.includes(option)) suggested.push(option);
  }
  const common: TimeZoneOption[] = [];
  for (const id of COMMON_TIME_ZONES) {
    const option = findTimeZoneOption(options, id);
    if (option && !suggested.includes(option) && !common.includes(option))
      common.push(option);
  }
  common.sort(
    (a, b) => a.offsetMinutes - b.offsetMinutes || a.id.localeCompare(b.id),
  );
  const groups: TimeZoneGroup[] = [];
  if (suggested.length > 0)
    groups.push({ name: "Suggested", options: suggested });
  if (common.length > 0) groups.push({ name: "Common", options: common });
  groups.push({ name: "All", options: [...options] });
  return groups;
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
  /** Builder state when `repeat` is "custom". */
  custom?: CustomRule;
}

// ---------------------------------------------------------------------------
// Custom repeat builder: "Every [N] [days|weeks|months|years]" with an optional
// end. The builder owns a small structured state and converts to and from the
// iCalendar rule the API stores; the rule text itself never reaches the UI.

export type IntervalUnit = "days" | "weeks" | "months" | "years";
export type MonthlyMode = "day" | "weekday";
export type EndsMode = "never" | "on" | "after";
export type OrdinalPosition = 1 | 2 | 3 | 4 | -1;

export const INTERVAL_UNITS: {
  key: IntervalUnit;
  singular: string;
  plural: string;
}[] = [
  { key: "days", singular: "day", plural: "days" },
  { key: "weeks", singular: "week", plural: "weeks" },
  { key: "months", singular: "month", plural: "months" },
  { key: "years", singular: "year", plural: "years" },
];

export const ORDINAL_POSITIONS: { value: OrdinalPosition; name: string }[] = [
  { value: 1, name: "first" },
  { value: 2, name: "second" },
  { value: 3, name: "third" },
  { value: 4, name: "fourth" },
  { value: -1, name: "last" },
];

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface CustomRule {
  /** Repeat every `interval` units; 1 or more. */
  interval: number;
  unit: IntervalUnit;
  /** Weeks: which days. */
  days: Weekday[];
  /** Months: a fixed day of the month, or an ordinal weekday. */
  monthlyMode: MonthlyMode;
  /** Months (day mode) and years: day of the month, 1–31. */
  monthDay: number;
  /** Months (weekday mode): first … fourth or last. */
  ordinal: OrdinalPosition;
  /** Months (weekday mode): which weekday. */
  weekday: Weekday;
  /** Years: month, 1–12. */
  month: number;
  ends: EndsMode;
  /** Ends "on": YYYY-MM-DD in the schedule's zone. */
  endDate: string;
  /** Ends "after": number of sends, 1 or more. */
  endCount: number;
  /**
   * Floating start (YYYYMMDDTHHMMSS, wall time in the schedule's zone) kept
   * from a saved rule so the interval cycle and send count stay anchored.
   */
  anchor?: string;
}

const FREQ_BY_UNIT: Record<IntervalUnit, string> = {
  days: "DAILY",
  weeks: "WEEKLY",
  months: "MONTHLY",
  years: "YEARLY",
};

const UNIT_BY_FREQ: Record<string, IntervalUnit> = {
  DAILY: "days",
  WEEKLY: "weeks",
  MONTHLY: "months",
  YEARLY: "years",
};

interface ZoneDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

/** Calendar fields of the instant `at` as seen in `timeZone` (UTC for unknown zones). */
export function zoneDate(at: Date, timeZone: string): ZoneDate {
  const zone = isKnownTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const weekdayText = parts.find((part) => part.type === "weekday")?.value;
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    weekday: SHORT_TO_KEY[weekdayText ?? ""] ?? "MO",
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** "YYYY-MM-DD" for a UTC calendar date built from year, month (1–12) and day. */
function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Parses "HH:MM"; invalid text returns null. */
function parseClock(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** "2026-10-31" → "Oct 31, 2026". Invalid text is returned unchanged. */
export function formatDateWords(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** A sensible starting point when the user switches to Custom. */
export function defaultCustomRule(now: Date, timeZone: string): CustomRule {
  const today = zoneDate(now, timeZone);
  return {
    interval: 2,
    unit: "weeks",
    days: [today.weekday],
    monthlyMode: "day",
    monthDay: today.day,
    ordinal: 1,
    weekday: today.weekday,
    month: today.month,
    ends: "never",
    endDate: isoDate(today.year, today.month + 1, today.day),
    endCount: 10,
  };
}

/**
 * The date part of a fresh anchor: today in `timeZone` when the chosen time is
 * still ahead, otherwise tomorrow, so a send count only covers future sends.
 */
function freshAnchorDate(
  now: Date,
  timeZone: string,
  clock: { hour: number; minute: number },
): string {
  const today = zoneDate(now, timeZone);
  const ahead =
    clock.hour > today.hour ||
    (clock.hour === today.hour && clock.minute > today.minute);
  const date = new Date(
    Date.UTC(today.year, today.month - 1, today.day + (ahead ? 0 : 1)),
  );
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/**
 * The rule text for the builder state, or "" when the state cannot form a rule
 * (an invalid time). A floating DTSTART line is included whenever the interval
 * or send count depends on a stable anchor.
 */
export function buildCustomRule(
  custom: CustomRule,
  time: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const clock = parseClock(time);
  if (!clock) return "";
  const interval = Math.max(1, Math.floor(custom.interval || 1));
  const fields = [`FREQ=${FREQ_BY_UNIT[custom.unit]}`];
  if (interval > 1) fields.push(`INTERVAL=${interval}`);
  if (custom.unit === "weeks") {
    const days = sortWeekdays(custom.days);
    if (days.length > 0) fields.push(`BYDAY=${days.join(",")}`);
  } else if (custom.unit === "months") {
    if (custom.monthlyMode === "weekday")
      fields.push(`BYDAY=${custom.ordinal}${custom.weekday}`);
    else fields.push(`BYMONTHDAY=${custom.monthDay}`);
  } else if (custom.unit === "years") {
    fields.push(`BYMONTH=${custom.month}`, `BYMONTHDAY=${custom.monthDay}`);
  }
  fields.push(`BYHOUR=${clock.hour}`, `BYMINUTE=${clock.minute}`, "BYSECOND=0");
  if (custom.ends === "on" && /^\d{4}-\d{2}-\d{2}$/.test(custom.endDate)) {
    fields.push(`UNTIL=${custom.endDate.replace(/-/g, "")}T235959`);
  } else if (custom.ends === "after") {
    fields.push(`COUNT=${Math.max(1, Math.floor(custom.endCount || 1))}`);
  }
  const body = fields.join(";");
  if (interval === 1 && custom.ends !== "after") return body;
  const anchorDate =
    custom.anchor?.slice(0, 8) ?? freshAnchorDate(now, timeZone, clock);
  const anchor = `${anchorDate}T${pad(clock.hour)}${pad(clock.minute)}00`;
  return `DTSTART:${anchor}\nRRULE:${body}`;
}

/** Splits a saved rule into its optional DTSTART line and the RRULE body. */
function ruleLines(
  rule: string,
): { start: string | null; body: string } | null {
  const lines = rule
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return null;
  const start = /^DTSTART/i.test(lines[0]) ? lines[0] : null;
  const rest = start ? lines.slice(1) : lines;
  if (rest.length !== 1) return null;
  return { start, body: rest[0].replace(/^RRULE:/i, "") };
}

/** A floating "YYYYMMDDTHHMMSS" anchor in `timeZone` for a DTSTART line, or null. */
function anchorFromStart(start: string, timeZone: string): string | null {
  const match = /^DTSTART(?:;TZID=([^:;]+))?:(\d{8})(?:T(\d{6})(Z?))?$/i.exec(
    start,
  );
  if (!match) return null;
  const [, tzid, date, clock, utc] = match;
  if (tzid && utc) return null;
  if (tzid) {
    if (!isKnownTimeZone(tzid)) return null;
    if (canonicalTimeZoneId(tzid) !== canonicalTimeZoneId(timeZone))
      return null;
  }
  if (utc) {
    const instant = new Date(
      Date.UTC(
        Number(date.slice(0, 4)),
        Number(date.slice(4, 6)) - 1,
        Number(date.slice(6, 8)),
        Number(clock.slice(0, 2)),
        Number(clock.slice(2, 4)),
        Number(clock.slice(4, 6)),
      ),
    );
    const wall = zoneDate(instant, timeZone);
    return `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}00`;
  }
  return `${date}T${clock ?? "000000"}`;
}

/** "YYYY-MM-DD" for an UNTIL value, converting UTC instants to the zone's date. */
function endDateFromUntil(until: string, timeZone: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(
    until,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (utc) {
    const wall = zoneDate(
      new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          Number(second),
        ),
      ),
      timeZone,
    );
    return isoDate(wall.year, wall.month, wall.day);
  }
  return `${year}-${month}-${day}`;
}

const BUILDER_KEYS = new Set([
  "FREQ",
  "INTERVAL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYHOUR",
  "BYMINUTE",
  "BYSECOND",
  "COUNT",
  "UNTIL",
  "WKST",
]);

function singleInteger(
  value: string | undefined,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/**
 * Builder state for a saved rule, or null when the builder cannot represent it
 * (several times a day, BYSETPOS, mixed day lists, hourly rules and so on).
 * The send time is read separately with localTimeFromRule.
 */
export function customFromRule(
  rule: string,
  timeZone: string,
  now: Date = new Date(),
): CustomRule | null {
  const lines = ruleLines(rule);
  if (!lines) return null;
  const fields = parseRule(lines.body);
  if (Object.keys(fields).some((key) => !BUILDER_KEYS.has(key))) return null;
  if (fields.WKST !== undefined && fields.WKST !== "MO") return null;
  const unit = UNIT_BY_FREQ[fields.FREQ ?? ""];
  if (!unit) return null;
  const interval = singleInteger(fields.INTERVAL, 1, 999);
  if (interval === null) return null;
  for (const key of ["BYHOUR", "BYMINUTE", "BYSECOND"]) {
    if (fields[key] !== undefined && !/^\d+$/.test(fields[key])) return null;
  }
  if (fields.BYSECOND !== undefined && Number(fields.BYSECOND) !== 0)
    return null;
  if (fields.COUNT !== undefined && fields.UNTIL !== undefined) return null;
  const count = singleInteger(fields.COUNT, 1, 999);
  if (count === null) return null;
  let endDate: string | null = null;
  if (fields.UNTIL !== undefined) {
    endDate = endDateFromUntil(fields.UNTIL, timeZone);
    if (!endDate) return null;
  }
  let anchor: string | undefined;
  if (lines.start) {
    const parsed = anchorFromStart(lines.start, timeZone);
    if (!parsed) return null;
    anchor = parsed;
  }
  const custom: CustomRule = {
    ...defaultCustomRule(now, timeZone),
    interval: interval ?? 1,
    unit,
    anchor,
    ends: count !== undefined ? "after" : endDate ? "on" : "never",
  };
  if (count !== undefined) custom.endCount = count;
  if (endDate) custom.endDate = endDate;
  const byDay = fields.BYDAY?.split(",") ?? [];
  const monthDay = singleInteger(fields.BYMONTHDAY, 1, 31);
  const month = singleInteger(fields.BYMONTH, 1, 12);
  if (monthDay === null || month === null) return null;
  if (unit === "days") {
    if (byDay.length > 0 || monthDay !== undefined || month !== undefined)
      return null;
    return custom;
  }
  if (unit === "weeks") {
    if (byDay.length === 0 || monthDay !== undefined || month !== undefined)
      return null;
    if (!byDay.every((day) => WEEKDAY_ORDER.includes(day as Weekday)))
      return null;
    custom.days = sortWeekdays(byDay as Weekday[]);
    return custom;
  }
  if (unit === "months") {
    if (month !== undefined) return null;
    if (monthDay !== undefined) {
      if (byDay.length > 0) return null;
      custom.monthlyMode = "day";
      custom.monthDay = monthDay;
      return custom;
    }
    if (byDay.length !== 1) return null;
    const match = /^(-?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay[0]);
    if (!match) return null;
    const position = Number(match[1]);
    if (![1, 2, 3, 4, -1].includes(position)) return null;
    custom.monthlyMode = "weekday";
    custom.ordinal = position as OrdinalPosition;
    custom.weekday = match[2] as Weekday;
    return custom;
  }
  if (byDay.length > 0 || monthDay === undefined || month === undefined)
    return null;
  custom.monthDay = monthDay;
  custom.month = month;
  return custom;
}

function weekdayName(key: Weekday): string {
  return WEEKDAYS.find((day) => day.key === key)?.name ?? key;
}

function ordinalName(position: OrdinalPosition): string {
  return (
    ORDINAL_POSITIONS.find((item) => item.value === position)?.name ??
    String(position)
  );
}

function endsText(custom: Pick<CustomRule, "ends" | "endDate" | "endCount">) {
  if (custom.ends === "on" && custom.endDate)
    return `, until ${formatDateWords(custom.endDate)}`;
  if (custom.ends === "after")
    return `, for ${custom.endCount} send${custom.endCount === 1 ? "" : "s"}`;
  return "";
}

/** "Every 2 weeks on Monday and Friday at 9:00 AM, Pakistan Time, for 10 sends". */
export function describeCustomRule(
  custom: CustomRule,
  time: string,
  timeZone: string,
  at: Date = new Date(),
): string {
  const interval = Math.max(1, Math.floor(custom.interval || 1));
  let head: string;
  if (custom.unit === "days") {
    head = interval > 1 ? `Every ${interval} days` : "Every day";
  } else if (custom.unit === "weeks") {
    const days = sortWeekdays(custom.days);
    if (days.length === 0) return "Pick at least one day";
    const names = listNames(days.map(weekdayName));
    if (interval > 1) head = `Every ${interval} weeks on ${names}`;
    else if (days.length === 7) head = "Every day";
    else if (days.join(",") === "MO,TU,WE,TH,FR") head = "Every weekday";
    else head = `Every ${names}`;
  } else if (custom.unit === "months") {
    const on =
      custom.monthlyMode === "weekday"
        ? `the ${ordinalName(custom.ordinal)} ${weekdayName(custom.weekday)}`
        : `the ${ordinal(custom.monthDay)}`;
    head =
      interval > 1
        ? `Every ${interval} months on ${on}`
        : `On ${on} of every month`;
  } else {
    const on = `${MONTH_NAMES[custom.month - 1] ?? custom.month} ${custom.monthDay}`;
    head =
      interval > 1 ? `Every ${interval} years on ${on}` : `Every year on ${on}`;
  }
  const zone = timeZoneRegionName(timeZone, at);
  return `${head} at ${formatClock(time)}, ${zone}${endsText(custom)}`;
}

function describeMonthDay(value: string): string {
  const number = Number(value);
  if (Number.isNaN(number)) return value;
  if (number === -1) return "last day";
  if (number < 0) return `${ordinal(-number)}-to-last day`;
  return ordinal(number);
}

function describeByDay(value: string): string {
  const match = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(value);
  if (!match) return value;
  const name = weekdayName(match[2].toUpperCase() as Weekday);
  if (!match[1]) return name;
  const position = Number(match[1]);
  if (position === -1) return `the last ${name}`;
  if (position < 0) return `the ${ordinal(-position)}-to-last ${name}`;
  const named = ORDINAL_POSITIONS.find((item) => item.value === position);
  return `the ${named ? named.name : ordinal(position)} ${name}`;
}

/**
 * Plain-English reading of any rule the API accepts, for schedules the builder
 * cannot edit. Never returns rule syntax.
 */
export function describeRuleText(
  rule: string,
  timeZone: string,
  at: Date = new Date(),
): string {
  const fields = parseRule(rule);
  const unitNames: Record<string, string> = {
    SECONDLY: "second",
    MINUTELY: "minute",
    HOURLY: "hour",
    DAILY: "day",
    WEEKLY: "week",
    MONTHLY: "month",
    YEARLY: "year",
  };
  const unit = unitNames[fields.FREQ ?? ""] ?? "period";
  const interval = Number(fields.INTERVAL ?? "1");
  const parts = [interval > 1 ? `Every ${interval} ${unit}s` : `Every ${unit}`];
  if (fields.BYMONTH) {
    parts.push(
      `in ${listNames(
        fields.BYMONTH.split(",").map(
          (month) => MONTH_NAMES[Number(month) - 1] ?? month,
        ),
      )}`,
    );
  }
  if (fields.BYWEEKNO)
    parts.push(`in week ${listNames(fields.BYWEEKNO.split(","))}`);
  if (fields.BYYEARDAY)
    parts.push(`on day ${listNames(fields.BYYEARDAY.split(","))} of the year`);
  if (fields.BYMONTHDAY)
    parts.push(
      `on the ${listNames(fields.BYMONTHDAY.split(",").map(describeMonthDay))}`,
    );
  if (fields.BYDAY)
    parts.push(`on ${listNames(fields.BYDAY.split(",").map(describeByDay))}`);
  if (fields.BYSETPOS) {
    const positions = fields.BYSETPOS.split(",").map((position) =>
      position === "-1" ? "last" : ordinal(Number(position)),
    );
    parts.push(`keeping only the ${listNames(positions)} match`);
  }
  const lines = ruleLines(rule);
  const anchor = lines?.start ? anchorFromStart(lines.start, timeZone) : null;
  if (fields.BYHOUR) {
    const hours = fields.BYHOUR.split(",");
    const minutes = fields.BYMINUTE?.split(",") ?? ["0"];
    const times: string[] = [];
    for (const hour of hours) {
      for (const minute of minutes) {
        times.push(formatClock(`${hour}:${minute.padStart(2, "0")}`));
      }
    }
    parts.push(`at ${listNames(times)}`);
  } else if (anchor) {
    parts.push(
      `at ${formatClock(`${anchor.slice(9, 11)}:${anchor.slice(11, 13)}`)}`,
    );
  }
  let text = `${parts.join(" ")}, ${timeZoneRegionName(timeZone, at)}`;
  if (anchor) {
    const startDate = `${anchor.slice(0, 4)}-${anchor.slice(4, 6)}-${anchor.slice(6, 8)}`;
    const today = zoneDate(at, timeZone);
    if (startDate > isoDate(today.year, today.month, today.day))
      text += `, starting ${formatDateWords(startDate)}`;
  }
  if (fields.COUNT) {
    text += endsText({
      ends: "after",
      endDate: "",
      endCount: Number(fields.COUNT),
    });
  } else if (fields.UNTIL) {
    const endDate = endDateFromUntil(fields.UNTIL, timeZone);
    if (endDate) text += endsText({ ends: "on", endDate, endCount: 0 });
  }
  return text;
}

/**
 * Turns what a user typed into the link prompt into a safe absolute URL.
 * Bare domains get https://; only http, https and mailto links are accepted.
 */
export function normalizeLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^(https?:|mailto:)/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return null;
    if (parsed.protocol !== "mailto:" && !parsed.hostname.includes("."))
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** One-line description such as "Every Monday at 9:00 AM, Pakistan Time". */
export function describeSchedule(input: SummaryInput): string {
  const clock = formatClock(input.time);
  const zone = timeZoneRegionName(input.timeZone, input.at ?? new Date());
  const tail = `at ${clock}, ${zone}`;
  if (input.repeat === "daily") return `Every day ${tail}`;
  if (input.repeat === "monthly")
    return `On the ${ordinal(input.monthDay)} of every month ${tail}`;
  if (input.repeat === "custom") {
    return input.custom
      ? describeCustomRule(input.custom, input.time, input.timeZone, input.at)
      : `Custom rule ${tail}`;
  }
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
