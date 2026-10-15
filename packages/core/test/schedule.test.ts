import { describe, expect, it } from "vitest";
import { nextOccurrence, presets, type Weekday } from "../src/index.js";

const date = (value: string) => new Date(value);
const next = (rule: string, zone: string, after: string) =>
  nextOccurrence(rule, zone, date(after))?.toISOString() ?? null;

describe("nextOccurrence", () => {
  it("preserves Monday 09:00 London over spring-forward", () => {
    const rule =
      "DTSTART;TZID=Europe/London:20260323T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    expect(next(rule, "Europe/London", "2026-03-22T12:00:00Z")).toBe(
      "2026-03-23T09:00:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-03-23T09:00:00Z")).toBe(
      "2026-03-30T08:00:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-03-30T08:00:00Z")).toBe(
      "2026-04-06T08:00:00.000Z",
    );
  });

  it("preserves London wall-clock time over fall-back", () => {
    const rule = presets.weekly(["MO"], { hour: 9 });
    expect(next(rule, "Europe/London", "2026-10-19T08:00:00Z")).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("handles daily DST and non-hour UTC offsets", () => {
    expect(
      next(
        presets.daily({ hour: 9 }),
        "America/New_York",
        "2026-03-07T14:00:00Z",
      ),
    ).toBe("2026-03-08T13:00:00.000Z");
    expect(
      next(
        presets.daily({ hour: 9, minute: 15 }),
        "Asia/Kathmandu",
        "2026-07-01T00:00:00Z",
      ),
    ).toBe("2026-07-01T03:30:00.000Z");
  });

  it("returns a strictly later occurrence and preserves second precision", () => {
    const rule = presets.daily({ hour: 9, minute: 15, second: 30 });
    expect(next(rule, "UTC", "2026-07-01T09:15:29.999Z")).toBe(
      "2026-07-01T09:15:30.000Z",
    );
    expect(next(rule, "UTC", "2026-07-01T09:15:30Z")).toBe(
      "2026-07-02T09:15:30.000Z",
    );
  });

  it.each([
    ["HOURLY", "2026-07-01T10:00:00.000Z"],
    ["MINUTELY", "2026-07-01T09:01:00.000Z"],
    ["SECONDLY", "2026-07-01T09:00:01.000Z"],
  ])("supports unbounded %s custom recurrences", (frequency, expected) => {
    const rule = `DTSTART:20260701T080000Z\nRRULE:FREQ=${frequency}`;
    expect(next(rule, "UTC", "2026-07-01T09:00:00Z")).toBe(expected);
  });

  it("uses UTC DTSTART as an instant that establishes local time", () => {
    const rule = "DTSTART:20260323T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    expect(next(rule, "Europe/London", "2026-03-23T09:00:00Z")).toBe(
      "2026-03-30T08:00:00.000Z",
    );
    const summer = "DTSTART:20260706T080000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO";
    expect(next(summer, "Europe/London", "2026-10-19T08:00:00Z")).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("supports floating DTSTART, INTERVAL, and finite COUNT without resetting", () => {
    const rule = "DTSTART:20260701T090000\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=2";
    expect(next(rule, "UTC", "2026-07-01T09:00:00Z")).toBe(
      "2026-07-03T09:00:00.000Z",
    );
    expect(next(rule, "UTC", "2026-07-03T09:00:00Z")).toBeNull();
  });

  it("honors inclusive UNTIL as a UTC instant across DST", () => {
    const rule =
      "DTSTART;TZID=Europe/London:20260323T090000\nRRULE:FREQ=WEEKLY;UNTIL=20260330T080000Z";
    expect(next(rule, "Europe/London", "2026-03-23T09:00:00Z")).toBe(
      "2026-03-30T08:00:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-03-30T08:00:00Z")).toBeNull();
    expect(
      next(
        rule.replace("080000Z", "075959Z"),
        "Europe/London",
        "2026-03-23T09:00:00Z",
      ),
    ).toBeNull();
  });

  it("skips nonexistent local times without consuming COUNT", () => {
    const rule =
      "DTSTART;TZID=Europe/London:20260328T013000\nRRULE:FREQ=DAILY;COUNT=2";
    expect(next(rule, "Europe/London", "2026-03-28T01:30:00Z")).toBe(
      "2026-03-30T00:30:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-03-30T00:30:00Z")).toBeNull();
  });

  it("sends once at the earlier instant of an ambiguous time", () => {
    const rule = "DTSTART;TZID=Europe/London:20261024T013000\nRRULE:FREQ=DAILY";
    expect(next(rule, "Europe/London", "2026-10-25T00:00:00Z")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-10-25T00:45:00Z")).toBe(
      "2026-10-26T01:30:00.000Z",
    );
    expect(next(rule, "Europe/London", "2026-10-25T01:00:00Z")).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  it("skips months without the selected date and supports leap days", () => {
    expect(
      next(presets.monthly(31, { hour: 9 }), "UTC", "2026-01-31T09:00:00Z"),
    ).toBe("2026-03-31T09:00:00.000Z");
    expect(
      next(
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        "UTC",
        "2026-01-01T00:00:00Z",
      ),
    ).toBe("2028-02-29T09:00:00.000Z");
  });

  it("supports ordinal weekdays in a custom rule", () => {
    expect(
      next(
        presets.custom(
          "FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        ),
        "UTC",
        "2026-07-01T00:00:00Z",
      ),
    ).toBe("2026-07-31T09:00:00.000Z");
  });

  it("accepts case-insensitive RRULE fields and folded iCalendar lines", () => {
    const rule =
      "dtstart;TZID=Europe/London:20260323T090000\r\nrrule:freq=weekly;\r\n byday=mo";
    expect(
      next(presets.custom(rule), "Europe/London", "2026-03-23T09:00:00Z"),
    ).toBe("2026-03-30T08:00:00.000Z");
  });

  it("rejects invalid dates, zones, and conflicting TZIDs", () => {
    expect(() =>
      nextOccurrence("FREQ=DAILY", "Mars/Olympus", date("2026-07-01")),
    ).toThrow(/timezone/);
    expect(() =>
      nextOccurrence("FREQ=DAILY", "UTC", new Date(Number.NaN)),
    ).toThrow(/Date/);
    expect(() =>
      next(
        "DTSTART;TZID=Europe/London:20260701T090000\nRRULE:FREQ=DAILY",
        "America/New_York",
        "2026-07-01Z",
      ),
    ).toThrow(/TZID/);
  });
});

describe("presets", () => {
  it("generates each preset with explicit time fields", () => {
    expect(presets.daily({ hour: 9 })).toBe(
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    );
    expect(presets.weekdays({ hour: 9, minute: 30 })).toBe(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30;BYSECOND=0",
    );
    expect(presets.weekly(["FR", "MO", "MO"], { hour: 8 })).toBe(
      "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
    );
    expect(presets.monthly(15, { hour: 12 })).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=12;BYMINUTE=0;BYSECOND=0",
    );
    expect(presets.custom(" RRULE:FREQ=DAILY;INTERVAL=2 ")).toBe(
      "RRULE:FREQ=DAILY;INTERVAL=2",
    );
  });

  it("weekdays skip weekends and chosen weekdays are honored", () => {
    expect(
      next(presets.weekdays({ hour: 9 }), "UTC", "2026-07-03T09:00:00Z"),
    ).toBe("2026-07-06T09:00:00.000Z");
    expect(
      next(
        presets.weekly(["WE", "FR"], { hour: 9 }),
        "UTC",
        "2026-07-01T09:00:00Z",
      ),
    ).toBe("2026-07-03T09:00:00.000Z");
  });

  it("rejects invalid preset arguments", () => {
    for (const time of [
      { hour: -1 },
      { hour: 24 },
      { hour: 1.5 },
      { hour: Number.NaN },
      { hour: 9, minute: 60 },
      { hour: 9, second: -1 },
    ]) {
      expect(() => presets.daily(time)).toThrow(RangeError);
    }
    for (const day of [0, 32, 1.5])
      expect(() => presets.monthly(day, { hour: 9 })).toThrow(RangeError);
    expect(() => presets.weekly([], { hour: 9 })).toThrow(RangeError);
    expect(() => presets.weekly(["XX" as Weekday], { hour: 9 })).toThrow(
      RangeError,
    );
  });

  it.each([
    "",
    "BYHOUR=9",
    "FREQ=INVALID",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;COUNT=-1",
    "FREQ=DAILY;COUNT=1,2",
    "FREQ=DAILY;COUNT=1;UNTIL=20260701T090000Z",
    "FREQ=DAILY;BYHOUR=24",
    "FREQ=DAILY;BYMINUTE=60",
    "FREQ=DAILY;BYSECOND=60",
    "FREQ=DAILY;BYMONTH=13",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=DAILY;BYDAY=XX",
    "FREQ=DAILY;BYDAY=1MO",
    "FREQ=MONTHLY;BYDAY=0MO",
    "FREQ=YEARLY;BYYEARDAY=367",
    "FREQ=WEEKLY;WKST=XX",
    "FREQ=WEEKLY;WKST=MO,TU",
    "FREQ=DAILY;FREQ=WEEKLY",
    "FREQ=DAILY;BYHOUR=NaN",
    "FREQ=DAILY;BYHOUR=1.5",
    "FREQ=DAILY;INTERVAL=9007199254740992",
    "FREQ=DAILY;UNTIL=20260230T090000Z",
    "FREQ=DAILY;BYYEARDAY=1",
    "FREQ=WEEKLY;BYMONTHDAY=1",
    "FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO",
    "FREQ=DAILY;BYWEEKNO=1",
    "FREQ=MONTHLY;BYSETPOS=1",
    "DTSTART:20260230T090000\nRRULE:FREQ=DAILY",
    "DTSTART;TZID=Invalid/Zone:20260701T090000\nRRULE:FREQ=DAILY",
    "DTSTART;TZID=Europe/London:20260701T090000Z\nRRULE:FREQ=DAILY",
    "FREQ=DAILY\nRRULE:FREQ=WEEKLY",
    "RRULE:FREQ=DAILY\nEXDATE:20260701T090000Z",
  ])("rejects invalid custom RRULE %s", (rule) => {
    expect(() => presets.custom(rule)).toThrow(RangeError);
    expect(() => nextOccurrence(rule, "UTC", date("2026-07-01"))).toThrow(
      RangeError,
    );
  });
});
