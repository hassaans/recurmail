import { nextOccurrence } from "@recurmail/core";
import { describe, expect, it } from "vitest";
import {
  buildCustomRule,
  type CustomRule,
  canonicalTimeZoneId,
  customFromRule,
  defaultCustomRule,
  describeCustomRule,
  describeRuleText,
  describeSchedule,
  ensureTimeZoneOption,
  filterTimeZones,
  findTimeZoneOption,
  groupTimeZones,
  repeatFromRule,
  timeZoneLabel,
  timeZoneOptions,
} from "../lib/schedule-editor";
import { LEGACY_ZONE_IDS } from "../lib/time-zone-aliases";

// 2026-10-15T04:20Z is Thursday 09:20 in Karachi.
const now = new Date("2026-10-15T04:20:00Z");
const zone = "Asia/Karachi";

function state(overrides: Partial<CustomRule>): CustomRule {
  return { ...defaultCustomRule(now, zone), ...overrides };
}

describe("custom rule builder", () => {
  it("starts from every 2 weeks on today's weekday, ending never", () => {
    expect(defaultCustomRule(now, zone)).toEqual({
      interval: 2,
      unit: "weeks",
      days: ["TH"],
      monthlyMode: "day",
      monthDay: 15,
      ordinal: 1,
      weekday: "TH",
      month: 10,
      ends: "never",
      endDate: "2026-11-15",
      endCount: 10,
    });
  });

  it("builds plain rules without an anchor when nothing depends on one", () => {
    expect(
      buildCustomRule(state({ interval: 1, unit: "days" }), "09:00", zone, now),
    ).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    expect(
      buildCustomRule(
        state({ interval: 1, unit: "weeks", days: ["FR", "MO"] }),
        "14:30",
        zone,
        now,
      ),
    ).toBe("FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=14;BYMINUTE=30;BYSECOND=0");
    expect(
      buildCustomRule(
        state({
          interval: 1,
          unit: "months",
          monthlyMode: "day",
          monthDay: 15,
        }),
        "09:00",
        zone,
        now,
      ),
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    expect(
      buildCustomRule(
        state({
          interval: 1,
          unit: "months",
          monthlyMode: "weekday",
          ordinal: -1,
          weekday: "FR",
        }),
        "09:00",
        zone,
        now,
      ),
    ).toBe("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
    expect(
      buildCustomRule(
        state({ interval: 1, unit: "years", month: 3, monthDay: 15 }),
        "09:00",
        zone,
        now,
      ),
    ).toBe(
      "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    );
    expect(
      buildCustomRule(
        state({ interval: 1, unit: "days", ends: "on", endDate: "2026-12-31" }),
        "09:00",
        zone,
        now,
      ),
    ).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;UNTIL=20261231T235959");
  });

  it("anchors interval and send-count rules to the next future send", () => {
    // 09:00 has passed in Karachi, so the anchor is tomorrow.
    expect(
      buildCustomRule(state({ interval: 3, unit: "days" }), "09:00", zone, now),
    ).toBe(
      "DTSTART:20261016T090000\nRRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    );
    // 10:00 is still ahead, so the anchor is today.
    expect(
      buildCustomRule(
        state({ interval: 2, unit: "weeks", days: ["MO", "FR"] }),
        "10:00",
        zone,
        now,
      ),
    ).toBe(
      "DTSTART:20261015T100000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=10;BYMINUTE=0;BYSECOND=0",
    );
    expect(
      buildCustomRule(
        state({ interval: 1, unit: "days", ends: "after", endCount: 5 }),
        "10:00",
        zone,
        now,
      ),
    ).toBe(
      "DTSTART:20261015T100000\nRRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0;COUNT=5",
    );
    // A saved anchor keeps its date and takes the chosen time.
    expect(
      buildCustomRule(
        state({ interval: 2, unit: "months", anchor: "20260101T090000" }),
        "11:15",
        zone,
        now,
      ),
    ).toBe(
      "DTSTART:20260101T111500\nRRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15;BYHOUR=11;BYMINUTE=15;BYSECOND=0",
    );
    expect(buildCustomRule(state({}), "9 am", zone, now)).toBe("");
  });

  it("round-trips every builder shape through the saved rule", () => {
    const shapes: Partial<CustomRule>[] = [
      { interval: 1, unit: "days" },
      { interval: 4, unit: "days", ends: "after", endCount: 3 },
      { interval: 1, unit: "weeks", days: ["MO", "WE", "FR"] },
      {
        interval: 2,
        unit: "weeks",
        days: ["SU"],
        ends: "on",
        endDate: "2027-01-31",
      },
      { interval: 1, unit: "months", monthlyMode: "day", monthDay: 31 },
      {
        interval: 3,
        unit: "months",
        monthlyMode: "weekday",
        ordinal: 2,
        weekday: "TU",
      },
      {
        interval: 1,
        unit: "months",
        monthlyMode: "weekday",
        ordinal: -1,
        weekday: "FR",
      },
      { interval: 1, unit: "years", month: 12, monthDay: 25 },
      {
        interval: 5,
        unit: "years",
        month: 1,
        monthDay: 1,
        ends: "after",
        endCount: 2,
      },
    ];
    for (const shape of shapes) {
      const custom = state(shape);
      const rule = buildCustomRule(custom, "09:30", zone, now);
      const parsed = customFromRule(rule, zone, now);
      expect(parsed, rule).not.toBeNull();
      const expected: CustomRule = { ...custom };
      if (rule.startsWith("DTSTART:")) expected.anchor = rule.slice(8, 23);
      expect(parsed).toEqual(expected);
      // Saving again without touching anything keeps the rule identical.
      expect(buildCustomRule(parsed as CustomRule, "09:30", zone, now)).toBe(
        rule,
      );
    }
  });

  it("reads UTC and zoned starts and ends into the schedule's zone", () => {
    const utcStart = customFromRule(
      "DTSTART:20261015T040000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      zone,
      now,
    );
    expect(utcStart?.anchor).toBe("20261015T090000");
    const zoned = customFromRule(
      "DTSTART;TZID=Asia/Karachi:20261015T090000\nRRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      zone,
      now,
    );
    expect(zoned?.anchor).toBe("20261015T090000");
    expect(
      customFromRule(
        "DTSTART;TZID=America/New_York:20261015T090000\nRRULE:FREQ=DAILY;INTERVAL=2",
        zone,
        now,
      ),
    ).toBeNull();
    // 2026-12-31T20:00Z is already January 1 in Karachi.
    const untilUtc = customFromRule(
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;UNTIL=20261231T200000Z",
      zone,
      now,
    );
    expect(untilUtc?.ends).toBe("on");
    expect(untilUtc?.endDate).toBe("2027-01-01");
    const untilDate = customFromRule("FREQ=DAILY;UNTIL=20261231", zone, now);
    expect(untilDate?.endDate).toBe("2026-12-31");
  });

  it("returns null for rules the builder cannot show", () => {
    const unrepresentable = [
      "FREQ=HOURLY;INTERVAL=6",
      "FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0;BYSECOND=0",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
      "FREQ=MONTHLY;BYDAY=1MO,3MO",
      "FREQ=MONTHLY;BYDAY=5MO",
      "FREQ=MONTHLY;BYMONTHDAY=1,15",
      "FREQ=MONTHLY;BYMONTHDAY=-1",
      "FREQ=WEEKLY;BYDAY=MO;BYMONTHDAY=1",
      "FREQ=WEEKLY",
      "FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1",
      "FREQ=YEARLY;BYYEARDAY=100",
      "FREQ=DAILY;COUNT=3;UNTIL=20261231",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=DAILY;WKST=SU",
      "FREQ=DAILY;BYSECOND=30",
      "DTSTART:20261015T090000\nRRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY",
      "",
    ];
    for (const rule of unrepresentable) {
      expect(customFromRule(rule, zone, now), rule).toBeNull();
    }
    expect(repeatFromRule("FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0;BYSECOND=0")).toBe(
      "custom",
    );
  });

  it("honours the send count and end date end to end with the core engine", () => {
    const counted = buildCustomRule(
      state({ interval: 2, unit: "days", ends: "after", endCount: 3 }),
      "10:00",
      zone,
      now,
    );
    const sends: Date[] = [];
    let after = now;
    for (let index = 0; index < 5; index++) {
      const next = nextOccurrence(counted, zone, after);
      if (!next) break;
      sends.push(next);
      after = next;
    }
    expect(sends.map((date) => date.toISOString())).toEqual([
      "2026-10-15T05:00:00.000Z",
      "2026-10-17T05:00:00.000Z",
      "2026-10-19T05:00:00.000Z",
    ]);
    const dated = buildCustomRule(
      state({ interval: 1, unit: "days", ends: "on", endDate: "2026-10-16" }),
      "10:00",
      zone,
      now,
    );
    const first = nextOccurrence(dated, zone, now);
    expect(first?.toISOString()).toBe("2026-10-15T05:00:00.000Z");
    const second = nextOccurrence(dated, zone, first as Date);
    expect(second?.toISOString()).toBe("2026-10-16T05:00:00.000Z");
    expect(nextOccurrence(dated, zone, second as Date)).toBeNull();
  });

  it("describes builder state in plain words", () => {
    const say = (shape: Partial<CustomRule>, time = "09:00") =>
      describeCustomRule(state(shape), time, zone, now);
    expect(say({ interval: 1, unit: "days" })).toBe(
      "Every day at 9:00 AM, Pakistan Time",
    );
    expect(say({ interval: 3, unit: "days" })).toBe(
      "Every 3 days at 9:00 AM, Pakistan Time",
    );
    expect(say({ interval: 2, unit: "weeks", days: ["FR", "MO"] })).toBe(
      "Every 2 weeks on Monday and Friday at 9:00 AM, Pakistan Time",
    );
    expect(
      say({ interval: 1, unit: "weeks", days: ["MO", "TU", "WE", "TH", "FR"] }),
    ).toBe("Every weekday at 9:00 AM, Pakistan Time");
    expect(say({ interval: 1, unit: "weeks", days: [] })).toBe(
      "Pick at least one day",
    );
    expect(
      say({ interval: 1, unit: "months", monthlyMode: "day", monthDay: 15 }),
    ).toBe("On the 15th of every month at 9:00 AM, Pakistan Time");
    expect(
      say({
        interval: 2,
        unit: "months",
        monthlyMode: "weekday",
        ordinal: 1,
        weekday: "MO",
      }),
    ).toBe("Every 2 months on the first Monday at 9:00 AM, Pakistan Time");
    expect(
      say({
        interval: 1,
        unit: "months",
        monthlyMode: "weekday",
        ordinal: -1,
        weekday: "FR",
      }),
    ).toBe("On the last Friday of every month at 9:00 AM, Pakistan Time");
    expect(say({ interval: 1, unit: "years", month: 3, monthDay: 15 })).toBe(
      "Every year on March 15 at 9:00 AM, Pakistan Time",
    );
    expect(
      say(
        { interval: 1, unit: "days", ends: "on", endDate: "2026-10-31" },
        "17:30",
      ),
    ).toBe("Every day at 5:30 PM, Pakistan Time, until Oct 31, 2026");
    expect(
      say({ interval: 1, unit: "days", ends: "after", endCount: 10 }),
    ).toBe("Every day at 9:00 AM, Pakistan Time, for 10 sends");
    expect(say({ interval: 1, unit: "days", ends: "after", endCount: 1 })).toBe(
      "Every day at 9:00 AM, Pakistan Time, for 1 send",
    );
    expect(
      describeSchedule({
        repeat: "custom",
        days: [],
        monthDay: 1,
        time: "09:00",
        timeZone: zone,
        at: now,
        custom: state({ interval: 2, unit: "weeks", days: ["TH"] }),
      }),
    ).toBe("Every 2 weeks on Thursday at 9:00 AM, Pakistan Time");
  });

  it("describes rules the builder cannot edit without showing rule syntax", () => {
    const cases: [string, string][] = [
      [
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0;BYSECOND=0",
        "Every month on Monday, Tuesday, Wednesday, Thursday and Friday keeping only the last match at 5:00 PM, Pakistan Time",
      ],
      [
        "FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0;BYSECOND=0",
        "Every day at 9:00 AM and 5:00 PM, Pakistan Time",
      ],
      [
        "FREQ=HOURLY;INTERVAL=6;BYMINUTE=0;BYSECOND=0;COUNT=4",
        "Every 6 hours, Pakistan Time, for 4 sends",
      ],
      [
        "FREQ=MONTHLY;BYMONTHDAY=-1,1;BYHOUR=8;BYMINUTE=0;BYSECOND=0;UNTIL=20261231T235959",
        "Every month on the last day and 1st at 8:00 AM, Pakistan Time, until Dec 31, 2026",
      ],
      [
        "FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=30;BYSECOND=0",
        "Every year in January and July on the 1st at 9:30 AM, Pakistan Time",
      ],
      [
        "FREQ=MONTHLY;BYDAY=2TU,-1FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        "Every month on the second Tuesday and the last Friday at 9:00 AM, Pakistan Time",
      ],
      [
        "DTSTART:20261101T083000\nRRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=MO",
        "Every 3 weeks on Monday at 8:30 AM, Pakistan Time, starting Nov 1, 2026",
      ],
    ];
    for (const [rule, expected] of cases) {
      const text = describeRuleText(rule, zone, now);
      expect(text, rule).toBe(expected);
      expect(text).not.toMatch(/RRULE|FREQ|BY[A-Z]+=/);
    }
  });
});

describe("time zone search aliases", () => {
  const at = new Date("2026-10-15T12:00:00Z");
  const options = timeZoneOptions(at);
  const first = (query: string) => filterTimeZones(options, query)[0]?.id;
  const ids = (query: string) =>
    filterTimeZones(options, query).map((option) => option.id);
  const kolkata = findTimeZoneOption(options, "Asia/Kolkata")?.id;

  it("matches abbreviations and ranks the usual zone first", () => {
    expect(first("PKT")).toBe("Asia/Karachi");
    expect(first("pkt")).toBe("Asia/Karachi");
    expect(first("IST")).toBe(kolkata);
    expect(ids("IST")).toEqual(
      expect.arrayContaining(["Asia/Jerusalem", "Europe/Dublin"]),
    );
    expect(first("EST")).toBe("America/New_York");
    expect(first("EDT")).toBe("America/New_York");
    expect(first("CST")).toBe("America/Chicago");
    expect(first("MST")).toBe("America/Denver");
    expect(first("PST")).toBe("America/Los_Angeles");
    expect(first("PDT")).toBe("America/Los_Angeles");
    expect(first("GMT")).toBe("Europe/London");
    expect(first("BST")).toBe("Europe/London");
    expect(ids("BST")).toContain("Asia/Dhaka");
    expect(["Europe/Berlin", "Europe/Paris"]).toContain(first("CET"));
    expect(first("JST")).toBe("Asia/Tokyo");
    expect(first("KST")).toBe("Asia/Seoul");
    expect(first("AEST")).toBe("Australia/Sydney");
    expect(first("GST")).toBe("Asia/Dubai");
    expect(first("SGT")).toBe("Asia/Singapore");
    expect(first("HKT")).toBe("Asia/Hong_Kong");
    expect(first("MSK")).toBe("Europe/Moscow");
    expect(first("NZST")).toBe("Pacific/Auckland");
    expect(first("SAST")).toBe("Africa/Johannesburg");
  });

  it("matches country names", () => {
    expect(first("Pakistan")).toBe("Asia/Karachi");
    expect(first("India")).toBe(kolkata);
    expect(first("United States")).toBe("America/New_York");
    expect(ids("United States")).toEqual(
      expect.arrayContaining([
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
        "Pacific/Honolulu",
      ]),
    );
    expect(first("USA")).toBe("America/New_York");
    expect(first("United Kingdom")).toBe("Europe/London");
    expect(first("UK")).toBe("Europe/London");
    expect(first("Germany")).toBe("Europe/Berlin");
    expect(first("UAE")).toBe("Asia/Dubai");
    expect(first("United Arab Emirates")).toBe("Asia/Dubai");
    expect(first("Japan")).toBe("Asia/Tokyo");
    expect(first("Australia")).toBe("Australia/Sydney");
    expect(first("Canada")).toBe("America/Toronto");
    expect(first("Brazil")).toBe("America/Sao_Paulo");
  });

  it("matches well-known cities that are not zone names", () => {
    expect(first("Lahore")).toBe("Asia/Karachi");
    expect(first("Islamabad")).toBe("Asia/Karachi");
    expect(first("Mumbai")).toBe(kolkata);
    expect(first("Delhi")).toBe(kolkata);
    expect(first("Bangalore")).toBe(kolkata);
    expect(first("San Francisco")).toBe("America/Los_Angeles");
    expect(first("Seattle")).toBe("America/Los_Angeles");
    expect(first("Toronto")).toBe("America/Toronto");
    expect(first("Montreal")).toBe("America/Toronto");
    expect(first("Sydney")).toBe("Australia/Sydney");
    expect(first("Manchester")).toBe("Europe/London");
    expect(first("Munich")).toBe("Europe/Berlin");
    expect(first("Abu Dhabi")).toBe("Asia/Dubai");
    expect(first("Beijing")).toBe("Asia/Shanghai");
  });

  it("keeps every runtime zone reachable under its canonical id", () => {
    const runtime = Intl.supportedValuesOf("timeZone");
    const canonical = new Set(runtime.map(canonicalTimeZoneId));
    expect(options.length).toBeGreaterThanOrEqual(canonical.size);
    for (const id of runtime) {
      expect(filterTimeZones(options, id).map((option) => option.id)).toContain(
        canonicalTimeZoneId(id),
      );
    }
    expect(findTimeZoneOption(options, "Asia/Kolkata")?.id).toBe(
      "Asia/Kolkata",
    );
    expect(findTimeZoneOption(options, "Asia/Calcutta")?.id).toBe(
      "Asia/Kolkata",
    );
    expect(findTimeZoneOption(options, "Mars/Olympus")).toBeUndefined();
  });

  it("lists every zone under its canonical id with no legacy duplicates", () => {
    const listed = new Set(options.map((option) => option.id));
    expect(listed.size).toBe(options.length);
    for (const [legacy, canonical] of Object.entries(LEGACY_ZONE_IDS)) {
      expect(listed.has(legacy), legacy).toBe(false);
      expect(listed.has(canonical), canonical).toBe(true);
    }
    expect(
      timeZoneLabel(findTimeZoneOption(options, "Asia/Calcutta")?.id ?? "", at),
    ).toBe("India Time (Asia/Kolkata), UTC+5:30");
    expect(findTimeZoneOption(options, "Europe/Kiev")?.id).toBe("Europe/Kyiv");
    expect(findTimeZoneOption(options, "Asia/Saigon")?.id).toBe(
      "Asia/Ho_Chi_Minh",
    );
    expect(findTimeZoneOption(options, "America/Buenos_Aires")?.id).toBe(
      "America/Argentina/Buenos_Aires",
    );
  });

  it("groups the current and browser zones first, then common, then all", () => {
    const groups = groupTimeZones(options, "Asia/Karachi", "America/New_York");
    expect(groups.map((group) => group.name)).toEqual([
      "Suggested",
      "Common",
      "All",
    ]);
    expect(groups[0].options.map((option) => option.id)).toEqual([
      "Asia/Karachi",
      "America/New_York",
    ]);
    const common = groups[1].options.map((option) => option.id);
    expect(common).toEqual(
      expect.arrayContaining(["UTC", "Europe/London", "Asia/Tokyo"]),
    );
    expect(common).not.toContain("Asia/Karachi");
    expect(common).not.toContain("America/New_York");
    for (let index = 1; index < groups[1].options.length; index++) {
      expect(groups[1].options[index].offsetMinutes).toBeGreaterThanOrEqual(
        groups[1].options[index - 1].offsetMinutes,
      );
    }
    expect(groups[2].options).toHaveLength(options.length);
    // Same zone twice collapses to one suggestion; no browser zone is fine.
    expect(
      groupTimeZones(options, "UTC", "UTC")[0].options.map((o) => o.id),
    ).toEqual(["UTC"]);
    expect(
      groupTimeZones(options, "UTC", null)[0].options.map((o) => o.id),
    ).toEqual(["UTC"]);
    // A saved canonical id that the runtime lists under its legacy name.
    const withKolkata = ensureTimeZoneOption(options, "Asia/Kolkata", at);
    expect(
      groupTimeZones(withKolkata, "Asia/Kolkata", null)[0].options[0].id,
    ).toBe("Asia/Kolkata");
    // Unknown current zone: no Suggested group, Common still first.
    expect(groupTimeZones(options, "Mars/Olympus", null)[0].name).toBe(
      "Common",
    );
  });
});
