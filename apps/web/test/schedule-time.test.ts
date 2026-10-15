import { describe, expect, it } from "vitest";
import {
  describeCadence,
  formatClock,
  formatClockWithZone,
  formatScheduleTime,
  repeatLabel,
  repeatSummary,
  sameMinute,
  zoneLabel,
} from "../lib/schedule-time";

describe("formatScheduleTime", () => {
  it("shows a Karachi schedule at its own local time with the PKT label", () => {
    expect(
      formatScheduleTime("2026-10-16T01:25:00.000Z", "Asia/Karachi", {
        year: false,
      }),
    ).toBe("Fri, Oct 16 at 6:25 AM PKT");
    expect(formatClock("2026-10-16T01:25:00.000Z", "Asia/Karachi")).toBe(
      "6:25 AM",
    );
    expect(
      formatClockWithZone("2026-10-16T01:25:00.000Z", "Asia/Karachi"),
    ).toBe("6:25 AM PKT");
  });

  it("switches New York between daylight and standard time across the DST change", () => {
    // 2026-11-01 06:00 UTC is the US DST end (2:00 AM EDT -> 1:00 AM EST).
    expect(
      formatScheduleTime("2026-11-01T05:30:00.000Z", "America/New_York", {
        year: false,
      }),
    ).toBe("Sun, Nov 1 at 1:30 AM EDT");
    expect(
      formatScheduleTime("2026-11-01T06:30:00.000Z", "America/New_York", {
        year: false,
      }),
    ).toBe("Sun, Nov 1 at 1:30 AM EST");
    expect(
      formatScheduleTime("2026-07-04T13:00:00.000Z", "America/New_York", {
        year: false,
      }),
    ).toBe("Sat, Jul 4 at 9:00 AM EDT");
  });

  it("labels UTC explicitly", () => {
    expect(
      formatScheduleTime("2026-10-16T06:25:00.000Z", "UTC", { year: false }),
    ).toBe("Fri, Oct 16 at 6:25 AM UTC");
    expect(zoneLabel("UTC", "2026-10-16T06:25:00.000Z")).toBe("UTC");
  });

  it("adds the year only for moments outside the current year", () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(
      formatScheduleTime(`${nextYear}-03-02T09:00:00.000Z`, "UTC"),
    ).toContain(`${nextYear}`);
    expect(
      formatScheduleTime("2026-10-16T06:25:00.000Z", "UTC", { year: true }),
    ).toBe("Fri, Oct 16, 2026 at 6:25 AM UTC");
  });

  it("names daylight-saving zones outside North America", () => {
    expect(zoneLabel("Europe/London", "2026-07-01T12:00:00.000Z")).toBe("BST");
    expect(zoneLabel("Europe/London", "2026-12-01T12:00:00.000Z")).toBe("GMT");
    expect(zoneLabel("Europe/Berlin", "2026-07-01T12:00:00.000Z")).toBe("CEST");
    expect(zoneLabel("Australia/Sydney", "2026-12-01T12:00:00.000Z")).toBe(
      "AEDT",
    );
    expect(zoneLabel("Asia/Kolkata", "2026-12-01T12:00:00.000Z")).toBe("IST");
  });

  it("falls back to a numeric offset for zones without a common abbreviation", () => {
    expect(zoneLabel("Pacific/Kiritimati", "2026-12-01T12:00:00.000Z")).toMatch(
      /^GMT\+14$/,
    );
  });

  it("never throws on bad input", () => {
    expect(formatScheduleTime("not a date", "Asia/Karachi")).toBe(
      "Time unavailable",
    );
    expect(formatScheduleTime("2026-10-16T06:25:00.000Z", "Mars/Olympus")).toBe(
      "Time unavailable",
    );
    expect(zoneLabel("Mars/Olympus", "2026-10-16T06:25:00.000Z")).toBe("UTC");
  });
});

describe("sameMinute", () => {
  it("treats moments in the same minute as equal and others as different", () => {
    expect(
      sameMinute("2026-10-14T09:00:00.000Z", "2026-10-14T09:00:42.000Z"),
    ).toBe(true);
    expect(
      sameMinute("2026-10-14T09:00:00.000Z", "2026-10-14T09:01:00.000Z"),
    ).toBe(false);
    expect(sameMinute("bad", "2026-10-14T09:01:00.000Z")).toBe(false);
  });
});

describe("cadence wording", () => {
  it("describes daily, weekday, weekly, monthly and custom rules", () => {
    expect(repeatSummary("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0")).toBe(
      "Every day",
    );
    expect(repeatSummary("FREQ=WEEKLY;BYDAY=MO,FR")).toBe(
      "Every week on Monday and Friday",
    );
    expect(repeatSummary("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe(
      "Every weekday",
    );
    expect(repeatSummary("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe(
      "Every 2 weeks on Friday",
    );
    expect(repeatSummary("FREQ=MONTHLY;BYMONTHDAY=1")).toBe(
      "Every month on day 1",
    );
    expect(repeatSummary("DTSTART:20261001T090000Z\nRRULE:FREQ=DAILY")).toBe(
      "Every day",
    );
    expect(repeatSummary("FREQ=HOURLY")).toBe("Custom recurring schedule");
  });

  it("adds the schedule-local send time from the rule", () => {
    expect(
      describeCadence(
        "FREQ=DAILY;BYHOUR=6;BYMINUTE=25;BYSECOND=0",
        "Asia/Karachi",
        "2026-10-16T01:25:00.000Z",
      ),
    ).toBe("Every day at 6:25 AM");
    expect(
      describeCadence(
        "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=15;BYSECOND=0",
        "UTC",
      ),
    ).toBe("Every week on Monday at 9:15 AM");
  });

  it("derives the send time from the next send when the rule has no clock", () => {
    expect(
      describeCadence(
        "DTSTART:20261001T090000Z\nRRULE:FREQ=DAILY",
        "Asia/Karachi",
        "2026-10-16T09:00:00.000Z",
      ),
    ).toBe("Every day at 2:00 PM");
    expect(describeCadence("FREQ=DAILY", "Asia/Karachi")).toBe("Every day");
  });

  it("labels card strips", () => {
    expect(repeatLabel("FREQ=DAILY")).toBe("Daily");
    expect(repeatLabel("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe("Weekdays");
    expect(repeatLabel("FREQ=WEEKLY;BYDAY=MO")).toBe("Weekly");
    expect(repeatLabel("FREQ=MONTHLY;BYMONTHDAY=1")).toBe("Monthly");
    expect(repeatLabel("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe(
      "Every 2 weeks",
    );
    expect(repeatLabel("FREQ=HOURLY")).toBe("Custom");
  });
});
