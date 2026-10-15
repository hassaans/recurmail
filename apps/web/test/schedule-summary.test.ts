import { describe, expect, it } from "vitest";
import {
  recipientSummary,
  senderAccounts,
  senderStatus,
  summarizeSchedule,
} from "../lib/schedule-summary";
import type { ScheduleRow } from "../lib/schedules";

const row: ScheduleRow = {
  id: "c4a7b913-3d35-4c0d-8e7c-4c5d101f3f88",
  user_id: "6a0d1d2e-9a0e-4c2e-9d61-0c1fcf6a7d11",
  subject: "Weekly check-in",
  body_text: "The weekly update.",
  body_html: null,
  to: ["one@example.test"],
  cc: ["two@example.test"],
  bcc: ["three@example.test", "four@example.test"],
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=15;BYSECOND=0",
  timezone: "Asia/Karachi",
  source: "web",
  status: "active",
  next_send_at: "2026-10-19T04:15:00.000Z",
  gmail_connection_id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

describe("recipientSummary", () => {
  it("names one or two recipients in full", () => {
    expect(recipientSummary(["one@example.test"])).toBe("one@example.test");
    expect(recipientSummary(["one@example.test", "two@example.test"])).toBe(
      "one@example.test and two@example.test",
    );
  });

  it("names the first two and counts the rest", () => {
    expect(
      recipientSummary([
        "one@example.test",
        "two@example.test",
        "three@example.test",
      ]),
    ).toBe("one@example.test, two@example.test and 1 more");
    expect(
      recipientSummary(Array.from({ length: 12 }, (_, i) => `${i}@x`)),
    ).toBe("0@x, 1@x and 10 more");
  });

  it("handles an empty list without crashing", () => {
    expect(recipientSummary([])).toBe("No recipients");
  });
});

describe("summarizeSchedule", () => {
  it("keeps only dashboard fields and merges to, cc and bcc in order", () => {
    expect(summarizeSchedule(row)).toEqual({
      id: row.id,
      subject: "Weekly check-in",
      recipients: "one@example.test, two@example.test and 2 more",
      rrule: row.rrule,
      timezone: "Asia/Karachi",
      status: "active",
      next_send_at: "2026-10-19T04:15:00.000Z",
      finished: null,
      gmail_connection_id: "11111111-1111-4111-8111-111111111111",
      sender: null,
    });
    expect(summarizeSchedule(row)).not.toHaveProperty("body_text");
    expect(summarizeSchedule(row)).not.toHaveProperty("user_id");
  });

  it("names the account the schedule sends from and reports its state", () => {
    const accounts = senderAccounts([
      {
        id: "22222222-2222-4222-8222-222222222222",
        google_email: "work@company.test",
        status: "needs_reconnect",
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        google_email: "owner@gmail.com",
        status: "connected",
      },
    ]);
    expect(accounts).toEqual([
      {
        id: "22222222-2222-4222-8222-222222222222",
        email: "work@company.test",
        status: "needs_reconnect",
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@gmail.com",
        status: "connected",
      },
    ]);
    const summary = summarizeSchedule(row, null, accounts);
    expect(summary.sender).toEqual({
      email: "owner@gmail.com",
      status: "connected",
    });
    expect(senderStatus(summary)).toBe("connected");
    const reconnect = summarizeSchedule(
      { ...row, gmail_connection_id: "22222222-2222-4222-8222-222222222222" },
      null,
      accounts,
    );
    expect(reconnect.sender).toEqual({
      email: "work@company.test",
      status: "needs_reconnect",
    });
    expect(senderStatus(reconnect)).toBe("needs_reconnect");
  });

  it("reports no sender once the account is gone", () => {
    const accounts = senderAccounts([
      {
        id: "22222222-2222-4222-8222-222222222222",
        google_email: "work@company.test",
        status: "connected",
      },
    ]);
    expect(summarizeSchedule(row, null, accounts).sender).toBeNull();
    expect(
      summarizeSchedule({ ...row, gmail_connection_id: null }, null, accounts)
        .sender,
    ).toBeNull();
    expect(senderStatus({ sender: null })).toBe("none");
  });

  it("carries the finished info the server derived", () => {
    const finished = { kind: "count" as const, total: 3, sent: 3 };
    expect(
      summarizeSchedule({ ...row, status: "paused" }, finished).finished,
    ).toEqual(finished);
  });
});
