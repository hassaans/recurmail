import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  ensureTimeZoneOption,
  filterTimeZones,
  formatClock,
  formatUtcOffset,
  isKnownTimeZone,
  isValidAddress,
  localTimeFromRule,
  ordinal,
  repeatFromRule,
  scheduleDefaults,
  sendTimeParts,
  splitAddresses,
  timeZoneLabel,
  timeZoneOffsetMinutes,
  timeZoneOptions,
  timeZoneRegionName,
  weekdaysFromRule,
} from "../lib/schedule-editor";

describe("recipient chip parsing", () => {
  it("splits on commas, semicolons, spaces and newlines", () => {
    expect(
      splitAddresses(
        "a@example.test, b@example.test;c@example.test\nd@example.test e@example.test",
      ),
    ).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
      "d@example.test",
      "e@example.test",
    ]);
  });

  it("drops blanks, angle brackets and case-insensitive duplicates", () => {
    expect(
      splitAddresses(" , <a@example.test> , A@EXAMPLE.TEST,, b@example.test "),
    ).toEqual(["a@example.test", "b@example.test"]);
  });

  it("handles a 400-address paste in one pass", () => {
    const pasted = Array.from(
      { length: 400 },
      (_, index) => `recipient${index}@example.test`,
    ).join(", ");
    const result = splitAddresses(pasted);
    expect(result).toHaveLength(400);
    expect(result[0]).toBe("recipient0@example.test");
    expect(result[399]).toBe("recipient399@example.test");
  });

  it("validates addresses the same way the API does", () => {
    expect(isValidAddress("ayesha@example.test")).toBe(true);
    expect(isValidAddress("first.last+tag@sub.example.co")).toBe(true);
    expect(isValidAddress("missing-at.example.test")).toBe(false);
    expect(isValidAddress("two@@example.test")).toBe(false);
    expect(isValidAddress(".dot@example.test")).toBe(false);
    expect(isValidAddress("a..b@example.test")).toBe(false);
    expect(isValidAddress("user@-bad.example")).toBe(false);
    expect(isValidAddress("user@example")).toBe(true);
    expect(isValidAddress(`${"x".repeat(65)}@example.test`)).toBe(false);
  });
});

describe("rule parsing", () => {
  it("maps rules to editor modes", () => {
    expect(repeatFromRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0")).toBe(
      "daily",
    );
    expect(
      repeatFromRule(
        "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      ),
    ).toBe("weekly");
    expect(
      repeatFromRule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0"),
    ).toBe("weekly");
    expect(
      repeatFromRule(
        "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      ),
    ).toBe("monthly");
    expect(repeatFromRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")).toBe("custom");
    expect(repeatFromRule("DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY")).toBe(
      "custom",
    );
    expect(repeatFromRule("FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1")).toBe("custom");
  });

  it("reads weekdays in Monday-first order and the local time", () => {
    expect(
      weekdaysFromRule("FREQ=WEEKLY;BYDAY=FR,MO,WE;BYHOUR=14;BYMINUTE=30"),
    ).toEqual(["MO", "WE", "FR"]);
    expect(
      localTimeFromRule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=14;BYMINUTE=30"),
    ).toBe("14:30");
    expect(localTimeFromRule("FREQ=DAILY")).toBe("09:00");
  });
});

describe("clock and ordinal formatting", () => {
  it("formats 24-hour times as 12-hour", () => {
    expect(formatClock("00:00")).toBe("12:00 AM");
    expect(formatClock("09:05")).toBe("9:05 AM");
    expect(formatClock("12:00")).toBe("12:00 PM");
    expect(formatClock("23:59")).toBe("11:59 PM");
    expect(formatClock("bad")).toBe("bad");
  });

  it("builds ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
  });
});

describe("time zone labels", () => {
  const october = new Date("2026-10-15T12:00:00Z");
  const january = new Date("2026-01-15T12:00:00Z");

  it("names zones with their region, IANA id and UTC offset", () => {
    expect(timeZoneLabel("Asia/Karachi", october)).toBe(
      "Pakistan Time (Asia/Karachi), UTC+5",
    );
    expect(timeZoneLabel("Asia/Kolkata", october)).toBe(
      "India Time (Asia/Kolkata), UTC+5:30",
    );
    expect(timeZoneLabel("UTC", october)).toBe(
      "Coordinated Universal Time (UTC), UTC+0",
    );
  });

  it("drops the Standard and Daylight qualifiers so labels are stable", () => {
    expect(timeZoneRegionName("America/New_York", october)).toBe(
      "Eastern Time",
    );
    expect(timeZoneRegionName("America/New_York", january)).toBe(
      "Eastern Time",
    );
    expect(timeZoneOffsetMinutes("America/New_York", october)).toBe(-240);
    expect(timeZoneOffsetMinutes("America/New_York", january)).toBe(-300);
    expect(timeZoneLabel("America/New_York", january)).toBe(
      "Eastern Time (America/New_York), UTC-5",
    );
  });

  it("formats offsets", () => {
    expect(formatUtcOffset(0)).toBe("UTC+0");
    expect(formatUtcOffset(300)).toBe("UTC+5");
    expect(formatUtcOffset(-240)).toBe("UTC-4");
    expect(formatUtcOffset(345)).toBe("UTC+5:45");
    expect(formatUtcOffset(-210)).toBe("UTC-3:30");
  });

  it("rejects unknown zones and returns the raw id for them", () => {
    expect(isKnownTimeZone("Asia/Karachi")).toBe(true);
    expect(isKnownTimeZone("Mars/Olympus")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    expect(isKnownTimeZone("not a zone")).toBe(false);
    expect(timeZoneLabel("Mars/Olympus", october)).toBe("Mars/Olympus");
  });

  it("lists every runtime zone sorted west to east with UTC included", () => {
    const options = timeZoneOptions(october);
    const ids = options.map((option) => option.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "UTC",
        "Asia/Karachi",
        "America/New_York",
        "Europe/London",
        "Pacific/Auckland",
      ]),
    );
    expect(options.length).toBeGreaterThan(300);
    for (let index = 1; index < options.length; index++) {
      expect(options[index].offsetMinutes).toBeGreaterThanOrEqual(
        options[index - 1].offsetMinutes,
      );
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("filters by any word in the label, id or city", () => {
    const options = timeZoneOptions(october);
    expect(
      filterTimeZones(options, "karachi").map((option) => option.id),
    ).toEqual(["Asia/Karachi"]);
    expect(
      filterTimeZones(options, "pakistan").map((option) => option.id),
    ).toEqual(["Asia/Karachi"]);
    expect(
      filterTimeZones(options, "new york").map((option) => option.id),
    ).toEqual(["America/New_York"]);
    const halfHour = filterTimeZones(options, "utc+5:30");
    expect(halfHour.length).toBeGreaterThan(0);
    expect(halfHour.every((option) => option.offsetMinutes === 330)).toBe(true);
    expect(filterTimeZones(options, "")).toHaveLength(options.length);
    expect(filterTimeZones(options, "zzzz")).toEqual([]);
  });

  it("ranks exact ids and name prefixes above offset-label matches", () => {
    const options = timeZoneOptions(october);
    const utc = filterTimeZones(options, "utc");
    expect(utc[0].id).toBe("UTC");
    expect(utc.length).toBe(options.length);
    const eastern = filterTimeZones(options, "eastern");
    const newYork = eastern.findIndex(
      (option) => option.id === "America/New_York",
    );
    expect(newYork).toBeGreaterThanOrEqual(0);
    // Everything ranked above New York is another "Eastern Time" zone, not an
    // offset-label match such as "UTC-4".
    expect(
      eastern
        .slice(0, newYork)
        .every((option) => option.region.startsWith("eastern")),
    ).toBe(true);
    const london = filterTimeZones(options, "lon").map((option) => option.id);
    expect(london).toContain("Europe/London");
    expect(london.indexOf("Europe/London")).toBeLessThan(
      london.indexOf("Asia/Colombo") === -1
        ? Infinity
        : london.indexOf("Asia/Colombo"),
    );
  });
});

describe("saved zones missing from the runtime list", () => {
  it("adds a known alias so an existing schedule still shows a label", () => {
    const options = timeZoneOptions(new Date("2026-10-15T12:00:00Z")).filter(
      (option) => option.id !== "Asia/Kolkata",
    );
    const withAlias = ensureTimeZoneOption(
      options,
      "Asia/Kolkata",
      new Date("2026-10-15T12:00:00Z"),
    );
    const added = withAlias.find((option) => option.id === "Asia/Kolkata");
    expect(added?.label).toBe("India Time (Asia/Kolkata), UTC+5:30");
    expect(withAlias).toHaveLength(options.length + 1);
    expect(ensureTimeZoneOption(withAlias, "Asia/Kolkata")).toHaveLength(
      withAlias.length,
    );
    expect(ensureTimeZoneOption(options, "Mars/Olympus")).toHaveLength(
      options.length,
    );
  });
});

describe("new schedule defaults", () => {
  it("picks the next whole hour and today's weekday in the browser zone", () => {
    // 2026-10-15T04:20Z is Thursday 09:20 in Karachi.
    const now = new Date("2026-10-15T04:20:00Z");
    expect(scheduleDefaults(now, "Asia/Karachi")).toEqual({
      weekday: "TH",
      time: "10:00",
    });
    // The same instant is Thursday 00:20 in New York.
    expect(scheduleDefaults(now, "America/New_York")).toEqual({
      weekday: "TH",
      time: "01:00",
    });
  });

  it("rolls 23:xx over to midnight on the following day", () => {
    // 2026-10-17T18:30Z is Saturday 23:30 in Karachi.
    const now = new Date("2026-10-17T18:30:00Z");
    expect(scheduleDefaults(now, "Asia/Karachi")).toEqual({
      weekday: "SU",
      time: "00:00",
    });
    // Sunday 23:30 in Karachi rolls to Monday.
    expect(
      scheduleDefaults(new Date("2026-10-18T18:30:00Z"), "Asia/Karachi"),
    ).toEqual({
      weekday: "MO",
      time: "00:00",
    });
  });

  it("falls back to UTC for unknown zones", () => {
    const now = new Date("2026-10-15T04:20:00Z");
    expect(scheduleDefaults(now, "Mars/Olympus")).toEqual({
      weekday: "TH",
      time: "05:00",
    });
  });
});

describe("schedule summary", () => {
  const at = new Date("2026-10-15T12:00:00Z");

  it("describes each repeat mode in plain words", () => {
    expect(
      describeSchedule({
        repeat: "weekly",
        days: ["MO"],
        monthDay: 1,
        time: "09:00",
        timeZone: "Asia/Karachi",
        at,
      }),
    ).toBe("Every Monday at 9:00 AM, Pakistan Time");
    expect(
      describeSchedule({
        repeat: "weekly",
        days: ["FR", "MO", "WE"],
        monthDay: 1,
        time: "14:30",
        timeZone: "America/New_York",
        at,
      }),
    ).toBe("Every Monday, Wednesday and Friday at 2:30 PM, Eastern Time");
    expect(
      describeSchedule({
        repeat: "weekly",
        days: ["MO", "TU", "WE", "TH", "FR"],
        monthDay: 1,
        time: "09:00",
        timeZone: "UTC",
        at,
      }),
    ).toBe("Every weekday at 9:00 AM, Coordinated Universal Time");
    expect(
      describeSchedule({
        repeat: "weekly",
        days: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
        monthDay: 1,
        time: "09:00",
        timeZone: "UTC",
        at,
      }),
    ).toBe("Every day at 9:00 AM, Coordinated Universal Time");
    expect(
      describeSchedule({
        repeat: "weekly",
        days: [],
        monthDay: 1,
        time: "09:00",
        timeZone: "UTC",
        at,
      }),
    ).toBe("Pick at least one day");
    expect(
      describeSchedule({
        repeat: "daily",
        days: [],
        monthDay: 1,
        time: "07:00",
        timeZone: "Europe/London",
        at,
      }),
    ).toBe("Every day at 7:00 AM, British Time");
    expect(
      describeSchedule({
        repeat: "monthly",
        days: [],
        monthDay: 22,
        time: "17:00",
        timeZone: "Asia/Karachi",
        at,
      }),
    ).toBe("On the 22nd of every month at 5:00 PM, Pakistan Time");
    expect(
      describeSchedule({
        repeat: "custom",
        days: [],
        monthDay: 1,
        time: "08:00",
        timeZone: "Asia/Karachi",
        at,
      }),
    ).toBe("Custom rule at 8:00 AM, Pakistan Time");
  });
});

describe("next send rows", () => {
  it("renders an instant in the schedule's zone, not the host zone", () => {
    expect(
      sendTimeParts(new Date("2026-10-19T04:00:00Z"), "Asia/Karachi"),
    ).toEqual({
      weekday: "Mon",
      day: "19",
      month: "Oct",
      year: "2026",
      time: "9:00 AM",
    });
    expect(
      sendTimeParts(new Date("2026-10-19T04:00:00Z"), "America/Los_Angeles"),
    ).toEqual({
      weekday: "Sun",
      day: "18",
      month: "Oct",
      year: "2026",
      time: "9:00 PM",
    });
  });
});
