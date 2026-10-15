import { describe, expect, it, vi } from "vitest";
import {
  type AccountType,
  dailyLimitCheck,
  type LimitSchedule,
  presets,
} from "../src/index.js";

const now = new Date("2026-07-01T00:00:00Z");
const recipients = (count: number) =>
  Array.from({ length: count }, (_, i) => `recipient${i}@example.test`);
const schedule = (overrides: Partial<LimitSchedule> = {}): LimitSchedule => ({
  status: "active",
  rrule: presets.daily({ hour: 9 }),
  timezone: "UTC",
  to: ["to@example.test"],
  ...overrides,
});
const once = (start: string, count: number): LimitSchedule =>
  schedule({
    rrule: `DTSTART:${start}\nRRULE:FREQ=DAILY;COUNT=1`,
    to: recipients(count),
  });

describe("dailyLimitCheck", () => {
  it("expands 30 days and returns useful busiest-window and horizon totals", () => {
    const result = dailyLimitCheck([schedule()], "gmail.com", now);
    expect(result).toMatchObject({
      status: "ok",
      count: 1,
      limit: 500,
      totalRecipients: 30,
      occurrenceCount: 30,
    });
    expect(result.window).toEqual({
      start: new Date("2026-07-01T09:00:00Z"),
      end: new Date("2026-07-02T09:00:00Z"),
      occurrenceCount: 1,
    });
    expect(result.range).toEqual({
      start: now,
      end: new Date("2026-07-31T00:00:00Z"),
    });
  });

  it("includes exact horizon endpoints and excludes sends outside the horizon", () => {
    const result = dailyLimitCheck(
      [
        once("20260701T000000Z", 1),
        once("20260731T000000Z", 2),
        once("20260630T235959Z", 10),
        once("20260731T000001Z", 20),
      ],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({
      count: 2,
      totalRecipients: 3,
      occurrenceCount: 2,
    });
  });

  it("finds a busy window spanning midnight rather than counting calendar dates", () => {
    const result = dailyLimitCheck(
      [once("20260701T230000Z", 300), once("20260702T010000Z", 250)],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({
      count: 550,
      status: "over",
      window: { occurrenceCount: 2 },
    });
  });

  it("counts sends just under 24 hours apart together, but excludes exactly 24 hours", () => {
    expect(
      dailyLimitCheck(
        [once("20260701T090000Z", 250), once("20260702T085959Z", 251)],
        "gmail.com",
        now,
      ).count,
    ).toBe(501);
    expect(
      dailyLimitCheck(
        [once("20260701T090000Z", 250), once("20260702T090000Z", 251)],
        "gmail.com",
        now,
      ).count,
    ).toBe(251);
  });

  it("finds a busier window later in the forecast and combines simultaneous sends", () => {
    const result = dailyLimitCheck(
      [
        once("20260701T000000Z", 10),
        once("20260720T120000Z", 200),
        once("20260720T120000Z", 201),
      ],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({
      count: 401,
      status: "warn",
      totalRecipients: 411,
      window: { start: new Date("2026-07-20T12:00:00Z"), occurrenceCount: 2 },
    });
  });

  it("warns for 450 Gmail recipients in one rolling window", () => {
    const result = dailyLimitCheck(
      [once("20260701T090000Z", 200), once("20260701T120000Z", 250)],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({
      count: 450,
      status: "warn",
      limit: 500,
      window: { start: new Date("2026-07-01T09:00:00Z"), occurrenceCount: 2 },
    });
  });

  it("allows 600 Workspace recipients in one rolling window", () => {
    const result = dailyLimitCheck(
      [once("20260701T090000Z", 300), once("20260701T120000Z", 300)],
      "workspace",
      now,
    );
    expect(result).toMatchObject({
      count: 600,
      status: "ok",
      limit: 2000,
      window: { start: new Date("2026-07-01T09:00:00Z"), occurrenceCount: 2 },
    });
  });

  it("counts To, Cc, and Bcc entries on every occurrence, including duplicates", () => {
    const result = dailyLimitCheck(
      [
        schedule({
          rrule: "DTSTART:20260701T090000Z\nRRULE:FREQ=HOURLY;COUNT=2",
          to: ["same@example.test"],
          cc: ["same@example.test", "cc@example.test"],
          bcc: recipients(200),
        }),
      ],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({
      count: 406,
      totalRecipients: 406,
      occurrenceCount: 2,
      status: "warn",
    });
  });

  it.each<[AccountType, number, number, string]>([
    ["gmail.com", 399, 500, "ok"],
    ["gmail.com", 400, 500, "warn"],
    ["gmail.com", 500, 500, "warn"],
    ["gmail.com", 501, 500, "over"],
    ["googlemail.com", 500, 500, "warn"],
    ["googlemail.com", 501, 500, "over"],
    ["workspace", 399, 2000, "ok"],
    ["workspace", 400, 2000, "ok"],
    ["workspace", 501, 2000, "ok"],
    ["workspace", 1599, 2000, "ok"],
    ["workspace", 1600, 2000, "warn"],
    ["workspace", 2000, 2000, "warn"],
    ["workspace", 2001, 2000, "over"],
  ])(
    "applies %s cap and threshold for %i deliveries",
    (account, count, limit, status) => {
      expect(
        dailyLimitCheck([once("20260701T090000Z", count)], account, now),
      ).toMatchObject({ count, limit, status });
    },
  );

  it("ignores paused and sending schedules before validating their rules", () => {
    const result = dailyLimitCheck(
      [
        schedule(),
        schedule({
          status: "paused",
          rrule: "invalid",
          timezone: "invalid",
          to: recipients(5000),
        }),
        schedule({ status: "sending", rrule: "invalid", to: recipients(5000) }),
      ],
      "gmail.com",
      now,
    );
    expect(result.count).toBe(1);
    expect(result.occurrenceCount).toBe(30);
  });

  it("returns an empty forecast with no window for no active occurrences", () => {
    expect(dailyLimitCheck([], "workspace", now)).toMatchObject({
      status: "ok",
      count: 0,
      window: null,
      totalRecipients: 0,
      occurrenceCount: 0,
    });
  });

  it("respects COUNT, UNTIL, and the pending-send anchor", () => {
    const result = dailyLimitCheck(
      [
        schedule({
          rrule: "DTSTART:20260629T090000Z\nRRULE:FREQ=DAILY;COUNT=3",
        }),
        schedule({
          rrule:
            "DTSTART:20260701T120000Z\nRRULE:FREQ=DAILY;UNTIL=20260702T120000Z",
        }),
        schedule({
          rrule: "FREQ=DAILY;INTERVAL=2;COUNT=2",
          nextSendAt: new Date("2026-07-04T09:00:00Z"),
        }),
      ],
      "gmail.com",
      now,
    );
    expect(result).toMatchObject({ occurrenceCount: 5, totalRecipients: 5 });
  });

  it("does not count recurrence instances before nextSendAt", () => {
    const result = dailyLimitCheck(
      [
        schedule({
          rrule: "DTSTART:20260701T090000Z\nRRULE:FREQ=DAILY;COUNT=3",
          nextSendAt: new Date("2026-07-03T09:00:00Z"),
        }),
      ],
      "gmail.com",
      now,
    );
    expect(result.occurrenceCount).toBe(1);
  });

  it("uses actual elapsed hours across DST, counting two spring-forward sends", () => {
    const result = dailyLimitCheck(
      [
        schedule({
          timezone: "Europe/London",
          to: recipients(300),
          rrule:
            "DTSTART;TZID=Europe/London:20260328T090000\nRRULE:FREQ=DAILY;COUNT=3",
        }),
      ],
      "gmail.com",
      new Date("2026-03-28T00:00:00Z"),
    );
    expect(result).toMatchObject({
      count: 600,
      status: "over",
      totalRecipients: 900,
      occurrenceCount: 3,
    });
  });

  it("does not consume COUNT on a nonexistent DST time", () => {
    const result = dailyLimitCheck(
      [
        schedule({
          timezone: "Europe/London",
          rrule:
            "DTSTART;TZID=Europe/London:20260328T013000\nRRULE:FREQ=DAILY;COUNT=2",
        }),
      ],
      "gmail.com",
      new Date("2026-03-28T00:00:00Z"),
    );
    expect(result).toMatchObject({ occurrenceCount: 2, totalRecipients: 2 });
  });

  it("defaults now to the current time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      expect(dailyLimitCheck([], "gmail.com").range.start).toEqual(now);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid dates, rules, and unknown account types", () => {
    expect(() =>
      dailyLimitCheck([], "gmail.com", new Date(Number.NaN)),
    ).toThrow(RangeError);
    expect(() => dailyLimitCheck([], "unknown" as AccountType, now)).toThrow(
      RangeError,
    );
    expect(() =>
      dailyLimitCheck([schedule({ rrule: "FREQ=BAD" })], "gmail.com", now),
    ).toThrow(RangeError);
    expect(() =>
      dailyLimitCheck(
        [schedule({ nextSendAt: new Date(Number.NaN) })],
        "gmail.com",
        now,
      ),
    ).toThrow(RangeError);
  });
});
