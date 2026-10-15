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
    for (const connection of ["connected", "disconnected"] as const) {
      expect(scheduleState("paused", connection)).toEqual({
        label: "Paused",
        tone: "muted",
        note: "Paused. Won't send until you resume.",
      });
    }
  });

  it("asks for a reconnect before offering Resume on a paused schedule whose sender needs it", () => {
    expect(
      scheduleState("paused", "needs_reconnect", null, "work@company.test"),
    ).toEqual({
      label: "Needs reconnect",
      tone: "warn",
      note: "Paused until you reconnect work@company.test.",
    });
  });

  it("asks for a sender when the schedule has none, whatever its status", () => {
    for (const status of ["active", "paused"] as const) {
      expect(scheduleState(status, "none")).toEqual({
        label: "No sender",
        tone: "warn",
        note: "No sender. Choose a Gmail account.",
      });
    }
    expect(scheduleState("sending", "none").label).toBe("Sending");
  });

  it("keeps a finished schedule finished even without a sender", () => {
    expect(
      scheduleState("paused", "none", { kind: "count", total: 2, sent: 2 }),
    ).toEqual({
      label: "Finished",
      tone: "muted",
      note: "Finished. Sent 2 of 2.",
    });
  });

  it("tells the user an active schedule is waiting on Gmail", () => {
    expect(scheduleState("active", "needs_reconnect")).toEqual({
      label: "Needs reconnect",
      tone: "warn",
      note: "Paused until you reconnect Gmail.",
    });
    expect(
      scheduleState("active", "needs_reconnect", null, "owner@gmail.com").note,
    ).toBe("Paused until you reconnect owner@gmail.com.");
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
