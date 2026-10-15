import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishedInfo,
  isFinishedSchedule,
  ruleCount,
} from "../lib/schedule-finished";
import { finishedNote, scheduleState } from "../lib/schedule-state";

const now = new Date("2026-10-15T12:00:00.000Z");

const countRule = "DTSTART:20261001T090000\nRRULE:FREQ=DAILY;COUNT=3";
const untilRule =
  "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;UNTIL=20260930T235959";
const foreverRule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0";

function paused(rrule: string, timezone = "UTC") {
  return { status: "paused" as const, rrule, timezone };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isFinishedSchedule", () => {
  it("is finished when a paused COUNT rule has sent its last occurrence", () => {
    expect(isFinishedSchedule(paused(countRule), now)).toBe(true);
  });

  it("is finished when a paused UNTIL rule has passed its end date", () => {
    expect(isFinishedSchedule(paused(untilRule, "Asia/Karachi"), now)).toBe(
      true,
    );
  });

  it("keeps a never-ending paused schedule as paused", () => {
    expect(isFinishedSchedule(paused(foreverRule), now)).toBe(false);
    expect(finishedInfo(paused(foreverRule), now)).toBeNull();
  });

  it("is not finished while the rule still has sends left", () => {
    const later = new Date("2026-10-02T12:00:00.000Z");
    expect(isFinishedSchedule(paused(countRule), later)).toBe(false);
    expect(
      isFinishedSchedule(paused(untilRule), new Date("2026-09-01T00:00:00Z")),
    ).toBe(false);
  });

  it("only applies to paused schedules", () => {
    expect(
      isFinishedSchedule(
        { status: "active", rrule: countRule, timezone: "UTC" },
        now,
      ),
    ).toBe(false);
    expect(
      isFinishedSchedule(
        { status: "sending", rrule: countRule, timezone: "UTC" },
        now,
      ),
    ).toBe(false);
  });

  it("treats a rule it cannot evaluate as not finished", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(isFinishedSchedule(paused("FREQ=NEVER"), now)).toBe(false);
    expect(isFinishedSchedule(paused(countRule, "Mars/Olympus"), now)).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("finishedInfo", () => {
  it("reports the COUNT and the sent total when given", () => {
    expect(finishedInfo(paused(countRule), now)).toEqual({
      kind: "count",
      total: 3,
      sent: null,
    });
    expect(finishedInfo(paused(countRule), now, 3)).toEqual({
      kind: "count",
      total: 3,
      sent: 3,
    });
  });

  it("formats a floating UNTIL as the wall date in the schedule's zone", () => {
    expect(finishedInfo(paused(untilRule, "Asia/Karachi"), now)).toEqual({
      kind: "until",
      endedOn: "Sep 30",
    });
  });

  it("adds the year when the end date is not in the current year", () => {
    const rule =
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;UNTIL=20251231T235959";
    expect(finishedInfo(paused(rule, "Asia/Karachi"), now)).toEqual({
      kind: "until",
      endedOn: "Dec 31, 2025",
    });
  });

  it("converts a UTC UNTIL into the schedule's zone", () => {
    const rule =
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;UNTIL=20260930T235959Z";
    expect(finishedInfo(paused(rule, "Pacific/Auckland"), now)).toEqual({
      kind: "until",
      endedOn: "Oct 1",
    });
    expect(finishedInfo(paused(rule, "America/Los_Angeles"), now)).toEqual({
      kind: "until",
      endedOn: "Sep 30",
    });
  });

  it("reads COUNT from a rule with a DTSTART line", () => {
    expect(ruleCount(countRule)).toBe(3);
    expect(ruleCount("RRULE:FREQ=WEEKLY;COUNT=12")).toBe(12);
    expect(ruleCount(untilRule)).toBeNull();
    expect(ruleCount(foreverRule)).toBeNull();
  });
});

describe("finishedNote", () => {
  it("counts sends when the send log was counted", () => {
    expect(finishedNote({ kind: "count", total: 10, sent: 10 })).toBe(
      "Finished. Sent 10 of 10.",
    );
    expect(finishedNote({ kind: "count", total: 10, sent: 9 })).toBe(
      "Finished. Sent 9 of 10.",
    );
  });

  it("falls back to the rule's count", () => {
    expect(finishedNote({ kind: "count", total: 10, sent: null })).toBe(
      "Finished after 10 sends.",
    );
    expect(finishedNote({ kind: "count", total: 1, sent: null })).toBe(
      "Finished after 1 send.",
    );
  });

  it("names the end date and has a plain fallback", () => {
    expect(finishedNote({ kind: "until", endedOn: "Dec 31" })).toBe(
      "Finished. Ended on Dec 31.",
    );
    expect(finishedNote({ kind: "ended" })).toBe(
      "Finished. The last send has gone out.",
    );
  });
});

describe("scheduleState for a finished schedule", () => {
  it("shows the Finished pill with the finished note on every connection", () => {
    for (const connection of [
      "connected",
      "needs_reconnect",
      "disconnected",
    ] as const) {
      expect(
        scheduleState("paused", connection, {
          kind: "count",
          total: 3,
          sent: 3,
        }),
      ).toEqual({
        label: "Finished",
        tone: "muted",
        note: "Finished. Sent 3 of 3.",
      });
    }
  });

  it("ignores finished info unless the schedule is paused", () => {
    expect(scheduleState("active", "connected", { kind: "ended" })).toEqual({
      label: "Active",
      tone: "teal",
      note: null,
    });
  });
});
