import { describe, expect, it } from "vitest";
import { countSchedules, scheduleState } from "../lib/schedule-state";

describe("scheduleState", () => {
  it("shows the next send only for an active schedule on a connected account", () => {
    expect(scheduleState("active", "connected")).toEqual({
      label: "Active",
      tone: "teal",
      note: null,
    });
  });

  it("replaces the next send with paused copy when the user paused it", () => {
    for (const connection of [
      "connected",
      "needs_reconnect",
      "disconnected",
    ] as const) {
      expect(scheduleState("paused", connection)).toEqual({
        label: "Paused",
        tone: "muted",
        note: "Paused. Won't send until you resume.",
      });
    }
  });

  it("tells the user an active schedule is waiting on Gmail", () => {
    expect(scheduleState("active", "needs_reconnect")).toEqual({
      label: "Needs reconnect",
      tone: "warn",
      note: "Paused until you reconnect Gmail.",
    });
    expect(scheduleState("active", "disconnected")).toEqual({
      label: "Waiting for Gmail",
      tone: "warn",
      note: "Won't send until you connect Gmail.",
    });
  });

  it("keeps a sending schedule on the sending pill with no note", () => {
    expect(scheduleState("sending", "disconnected")).toEqual({
      label: "Sending",
      tone: "teal",
      note: null,
    });
  });
});

describe("countSchedules", () => {
  it("pluralises", () => {
    expect(countSchedules(1)).toBe("1 schedule");
    expect(countSchedules(0)).toBe("0 schedules");
    expect(countSchedules(3)).toBe("3 schedules");
  });
});
