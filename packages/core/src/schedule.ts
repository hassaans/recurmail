import { DateTime, IANAZone } from "luxon";
import type { RRule as RecurrenceRule } from "rrule";
import * as rrule from "rrule";

// Bundlers resolve rrule's ESM entry; native Node/Deno expose its CJS exports
// through default because the CJS bundle does not support named imports.
const rruleExports = rrule as typeof rrule & { default?: typeof rrule };
const { RRule } = rruleExports.default ?? rruleExports;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** Local wall-clock time; omitted minutes and seconds default to zero. */
export interface PresetTime {
  hour: number;
  minute?: number;
  second?: number;
}

function integer(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
}

function timeParts(time: PresetTime): string {
  integer(time.hour, 0, 23, "hour");
  integer(time.minute ?? 0, 0, 59, "minute");
  integer(time.second ?? 0, 0, 59, "second");
  return `BYHOUR=${time.hour};BYMINUTE=${time.minute ?? 0};BYSECOND=${time.second ?? 0}`;
}

/** Presets return RRULE strings with explicit local time, usable in any IANA zone. */
export const presets = {
  daily(time: PresetTime): string {
    return `FREQ=DAILY;${timeParts(time)}`;
  },
  weekdays(time: PresetTime): string {
    return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;${timeParts(time)}`;
  },
  weekly(days: readonly Weekday[], time: PresetTime): string {
    if (days.length === 0 || days.some((day) => !WEEKDAYS.includes(day))) {
      throw new RangeError("weekly requires at least one valid weekday");
    }
    const chosen = WEEKDAYS.filter((day) => days.includes(day));
    return `FREQ=WEEKLY;BYDAY=${chosen.join(",")};${timeParts(time)}`;
  },
  /** Dates absent from a month (e.g. February 31) are skipped. */
  monthly(day: number, time: PresetTime): string {
    integer(day, 1, 31, "day of month");
    return `FREQ=MONTHLY;BYMONTHDAY=${day};${timeParts(time)}`;
  },
  custom(value: string): string {
    parse(value);
    return value.trim().replace(/\r\n/g, "\n");
  },
};

interface ParsedRule {
  body: string;
  start?: { wall: Date; utc: boolean; timezone?: string };
  until?: { wall: Date; utc: boolean };
  count?: number;
}

function calendarDate(value: string): { wall: Date; utc: boolean } {
  const normalized = value.toUpperCase();
  if (!/^\d{8}(?:T\d{6}Z?)?$/.test(normalized)) {
    throw new RangeError("RRULE dates must be YYYYMMDD or YYYYMMDDTHHMMSS[Z]");
  }
  const utc = normalized.endsWith("Z");
  const text = utc ? normalized.slice(0, -1) : normalized;
  const date = DateTime.fromFormat(
    text,
    text.includes("T") ? "yyyyMMdd'T'HHmmss" : "yyyyMMdd",
    { zone: "UTC" },
  );
  if (!date.isValid) throw new RangeError("Invalid RRULE calendar date");
  return { wall: date.toJSDate(), utc };
}

function validateZone(timezone: string): void {
  if (!IANAZone.isValidZone(timezone)) {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`);
  }
}

function parse(value: string): ParsedRule {
  const lines = value
    .trim()
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/);
  let start: ParsedRule["start"];
  if (lines[0]?.toUpperCase().startsWith("DTSTART")) {
    const match = /^DTSTART(?:;TZID=([^:;]+))?:(.+)$/i.exec(
      lines.shift() ?? "",
    );
    if (!match) throw new RangeError("Invalid DTSTART");
    const date = calendarDate(match[2]);
    if (match[1]) {
      validateZone(match[1]);
      if (date.utc) throw new RangeError("DTSTART cannot combine TZID and Z");
    }
    start = { ...date, timezone: match[1] };
  }
  if (lines.length !== 1) {
    throw new RangeError("Expected one RRULE and an optional DTSTART");
  }
  const body = lines[0].toUpperCase().replace(/^RRULE:/, "");
  const fields = new Map<string, string>();
  const ranges: Record<string, readonly [number, number]> = {
    INTERVAL: [1, 2_147_483_647],
    COUNT: [1, 2_147_483_647],
    BYSECOND: [0, 59],
    BYMINUTE: [0, 59],
    BYHOUR: [0, 23],
    BYMONTH: [1, 12],
    BYMONTHDAY: [-31, 31],
    BYYEARDAY: [-366, 366],
    BYWEEKNO: [-53, 53],
    BYSETPOS: [-366, 366],
  };
  let until: ParsedRule["until"];
  for (const field of body.split(";")) {
    const match = /^([A-Z]+)=([^=\s]+)$/.exec(field);
    if (!match || fields.has(match[1])) {
      throw new RangeError("Invalid or duplicate RRULE property");
    }
    const [, key, text] = match;
    fields.set(key, text);
    if (key in ranges) {
      const values = text.split(",");
      if ((key === "COUNT" || key === "INTERVAL") && values.length !== 1) {
        throw new RangeError(`${key} requires a single integer`);
      }
      const [min, max] = ranges[key];
      for (const item of values) {
        if (!/^[+-]?\d+$/.test(item)) throw new RangeError(`Invalid ${key}`);
        integer(Number(item), min, max, key);
        if (min < 0 && Number(item) === 0)
          throw new RangeError(`Invalid ${key}`);
      }
    } else if (key === "FREQ") {
      if (
        !/^(YEARLY|MONTHLY|WEEKLY|DAILY|HOURLY|MINUTELY|SECONDLY)$/.test(text)
      ) {
        throw new RangeError("Invalid FREQ");
      }
    } else if (key === "BYDAY" || key === "WKST") {
      for (const item of text.split(",")) {
        const day = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
        if (!day || (key === "WKST" && (day[1] || text.includes(",")))) {
          throw new RangeError(`Invalid ${key}`);
        }
        if (day[1]) {
          integer(Number(day[1]), -53, 53, "weekday ordinal");
          if (Number(day[1]) === 0)
            throw new RangeError("Invalid weekday ordinal");
        }
      }
    } else if (key === "UNTIL") {
      until = calendarDate(text);
    } else {
      throw new RangeError(`Unsupported RRULE property: ${key}`);
    }
  }
  if (!fields.has("FREQ")) throw new RangeError("RRULE requires FREQ");
  if (fields.has("COUNT") && until) {
    throw new RangeError("COUNT and UNTIL cannot be combined");
  }
  if (
    /[+-]?\d/.test(fields.get("BYDAY") ?? "") &&
    !["MONTHLY", "YEARLY"].includes(fields.get("FREQ") ?? "")
  ) {
    throw new RangeError("Ordinal BYDAY requires MONTHLY or YEARLY");
  }
  if (fields.has("BYWEEKNO") && fields.get("FREQ") !== "YEARLY") {
    throw new RangeError("BYWEEKNO requires YEARLY");
  }
  if (
    fields.has("BYYEARDAY") &&
    ["DAILY", "WEEKLY", "MONTHLY"].includes(fields.get("FREQ") ?? "")
  ) {
    throw new RangeError(
      "BYYEARDAY cannot be used with DAILY, WEEKLY, or MONTHLY",
    );
  }
  if (fields.has("BYMONTHDAY") && fields.get("FREQ") === "WEEKLY") {
    throw new RangeError("BYMONTHDAY cannot be used with WEEKLY");
  }
  if (fields.has("BYWEEKNO") && /\d/.test(fields.get("BYDAY") ?? "")) {
    throw new RangeError("Ordinal BYDAY cannot be combined with BYWEEKNO");
  }
  if (
    fields.has("BYSETPOS") &&
    ![...fields.keys()].some(
      (key) => key.startsWith("BY") && key !== "BYSETPOS",
    )
  ) {
    throw new RangeError("BYSETPOS requires another BY property");
  }
  return {
    body,
    start,
    until,
    count: fields.has("COUNT") ? Number(fields.get("COUNT")) : undefined,
  };
}

function validDate(date: Date): void {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid Date");
}

/** Store calendar fields in a UTC Date without applying a host timezone. */
function wallDate(date: Date, timezone: string): Date {
  return DateTime.fromJSDate(date, { zone: timezone })
    .setZone("UTC", { keepLocalTime: true })
    .toJSDate();
}

/** Skip nonexistent times; send once at the earlier instant of a repeated time. */
function instant(wall: Date, timezone: string): Date | null {
  const local = DateTime.fromJSDate(wall, { zone: "UTC" }).setZone(timezone, {
    keepLocalTime: true,
  });
  if (
    !local.isValid ||
    wallDate(local.toJSDate(), timezone).getTime() !== wall.getTime()
  ) {
    return null;
  }
  return new Date(
    Math.min(...local.getPossibleOffsets().map((date) => date.toMillis())),
  );
}

interface PreparedRule {
  rule: RecurrenceRule;
  count?: number;
  until?: Date;
}

function prepare(value: string, timezone: string, anchor: Date): PreparedRule {
  validDate(anchor);
  validateZone(timezone);
  const parsed = parse(value);
  if (parsed.start?.timezone) {
    const canonical = (zone: string) =>
      new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
        .timeZone;
    if (canonical(parsed.start.timezone) !== canonical(timezone)) {
      throw new RangeError("DTSTART TZID must match timezone");
    }
  }
  const start = parsed.start
    ? parsed.start.utc
      ? wallDate(parsed.start.wall, timezone)
      : parsed.start.wall
    : wallDate(new Date(Math.floor(anchor.getTime() / 1000) * 1000), timezone);
  const until = parsed.until
    ? parsed.until.utc
      ? parsed.until.wall
      : instant(parsed.until.wall, timezone)
    : undefined;
  if (parsed.until && !until)
    throw new RangeError("UNTIL is a nonexistent local time");
  const rule = new RRule(
    {
      ...RRule.parseString(parsed.body),
      dtstart: start,
      tzid: null,
      count: null,
      // Widen the floating bound, then apply the actual inclusive instant below.
      until: until
        ? new Date(wallDate(until, timezone).getTime() + DAY_MS)
        : null,
    },
    true,
  );
  return { rule, count: parsed.count, until: until ?? undefined };
}

/**
 * First occurrence strictly after `after`, returned as a real UTC instant.
 * DTSTART may be local, TZID-qualified, or UTC. Without DTSTART, `after` supplies
 * the start and unspecified local time fields; persist DTSTART for COUNT/INTERVAL
 * rules that must keep their original anchor across calls. Gaps are skipped and
 * repeated local times use the earlier instant, once.
 */
export function nextOccurrence(
  value: string,
  timezone: string,
  after: Date,
): Date | null {
  const prepared = prepare(value, timezone, after);
  let result: Date | null = null;
  if (prepared.count !== undefined) {
    let emitted = 0;
    prepared.rule.all((wall) => {
      const date = instant(wall, timezone);
      if (!date) return true;
      if (prepared.until && date > prepared.until) return false;
      emitted++;
      if (date > after) {
        result = date;
        return false;
      }
      return emitted < (prepared.count ?? 0);
    });
    return result;
  }
  // Earlier local times cannot be future sends because repeated times always
  // select their first instant. Start here rather than replaying a whole day.
  let cursor = wallDate(after, timezone);
  while (true) {
    const wall = prepared.rule.after(cursor, true);
    if (!wall) return null;
    const date = instant(wall, timezone);
    if (date && prepared.until && date > prepared.until) return null;
    if (date && date > after) return date;
    cursor = new Date(wall.getTime() + 1);
  }
}

/** Internal shared expansion; both real-time endpoints are inclusive. */
export function occurrencesBetween(
  value: string,
  timezone: string,
  from: Date,
  to: Date,
  anchor: Date = from,
): Date[] {
  validDate(from);
  validDate(to);
  const prepared = prepare(value, timezone, anchor);
  if (from > to) return [];
  const dates: Date[] = [];
  const visit = (wall: Date): boolean => {
    const date = instant(wall, timezone);
    if (!date) return true;
    if (date > to || (prepared.until && date > prepared.until)) return false;
    if (date >= from) dates.push(date);
    return true;
  };
  if (prepared.count !== undefined) {
    let emitted = 0;
    prepared.rule.all((wall) => {
      if (!instant(wall, timezone)) return true;
      emitted++;
      return visit(wall) && emitted < (prepared.count ?? 0);
    });
  } else {
    prepared.rule.between(
      new Date(wallDate(from, timezone).getTime() - DAY_MS),
      new Date(wallDate(to, timezone).getTime() + DAY_MS),
      true,
      visit,
    );
  }
  return dates;
}
