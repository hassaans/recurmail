import { describe, expect, it, vi } from "vitest";
import {
  dailyLimitCheck,
  type LimitSchedule,
} from "../../../packages/core/src/index";
import type { PublicConnection } from "../lib/connections";
import type { Identity } from "../lib/gmail-flow";
import { createScheduleStore } from "../lib/schedule-store";
import type { SendHistoryRow } from "../lib/schedules";
import {
  createScheduleHandlers,
  validateScheduleInput,
} from "../lib/schedules";

const origin = "https://app.test";
const instant = Date.parse("2026-07-01T09:00:00Z");
const nextSendAt = "2026-07-02T09:00:00.000Z";
const owner = { id: "owner", email: "owner@gmail.com" };
const accessToken = "fake-access";

interface ScheduleInput {
  subject: string;
  body_text: string;
  body_html: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  rrule: string;
  timezone: string;
  source: "web" | "api" | "cli" | "mcp";
}

interface ScheduleRow extends ScheduleInput {
  id: string;
  user_id: string;
  status: "active" | "paused" | "sending";
  next_send_at: string;
  created_at: string;
  updated_at: string;
}

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    subject: "Daily reminder",
    body_text: "Remember to send the report.",
    body_html: "<p>Remember to send the report.</p>",
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    timezone: "UTC",
    source: "web",
    ...overrides,
  };
}

function row(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    ...input(),
    id: "schedule-1",
    user_id: owner.id,
    status: "active",
    next_send_at: nextSendAt,
    created_at: "2026-06-30T09:00:00.000Z",
    updated_at: "2026-06-30T09:00:00.000Z",
    ...overrides,
  };
}

function request(
  path = "/api/schedules",
  method = "GET",
  body?: unknown,
  requestOrigin: string | null = origin,
) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" && requestOrigin !== null
        ? { Origin: requestOrigin }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Intended contract: authenticated JSON handlers expose list/create/get/patch/
// delete/pause/resume/pauseAll. Item methods take (request, id). Single-item
// responses wrap `schedule`; list wraps `schedules`; create/patch/resume expose
// the JSON-serialized core result as `dailyLimitCheck` and an optional `warning`.
// Store operations receive the verified owner and session token, except create,
// which receives an owner-bound row and token. Validation returns normalized
// input or throws for an invalid payload. No network or real clock is needed.
function fixture(
  seed: ScheduleRow[] = [],
  connectionOverrides: Partial<PublicConnection> = {},
) {
  const rows = structuredClone(seed);
  const connection: PublicConnection = {
    user_id: owner.id,
    google_email: owner.email,
    is_workspace: false,
    status: "connected",
    connected_at: "2026-06-30T09:00:00.000Z",
    ...connectionOverrides,
  };
  const find = (userId: string, id: string) =>
    rows.find((saved) => saved.user_id === userId && saved.id === id);
  const store = {
    list: vi.fn(async (userId: string, _token: string) =>
      structuredClone(rows.filter((saved) => saved.user_id === userId)),
    ),
    get: vi.fn(async (userId: string, id: string, _token: string) =>
      structuredClone(find(userId, id) ?? null),
    ),
    create: vi.fn(async (saved: Omit<ScheduleRow, "id">, _token: string) => {
      const created = { ...structuredClone(saved), id: "created-schedule" };
      rows.push(created);
      return structuredClone(created);
    }),
    update: vi.fn(
      async (
        userId: string,
        id: string,
        changes: Partial<ScheduleRow>,
        _token: string,
      ) => {
        const saved = find(userId, id);
        if (!saved) return null;
        Object.assign(saved, structuredClone(changes));
        return structuredClone(saved);
      },
    ),
    delete: vi.fn(async (userId: string, id: string, _token: string) => {
      const index = rows.findIndex(
        (saved) => saved.user_id === userId && saved.id === id,
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    }),
    pauseAll: vi.fn(async (userId: string, _token: string) => {
      let count = 0;
      for (const saved of rows) {
        if (saved.user_id === userId && saved.status === "active") {
          saved.status = "paused";
          count++;
        }
      }
      return count;
    }),
    readConnection: vi.fn(async (userId: string, _token: string) =>
      userId === connection.user_id ? structuredClone(connection) : null,
    ),
    history: vi.fn(async () => [] as SendHistoryRow[]),
  };
  const authenticate = vi.fn<(request: Request) => Promise<Identity | null>>(
    async () => ({ user: owner, accessToken }),
  );
  const now = vi.fn(() => instant);
  const handlers = createScheduleHandlers({ origin, authenticate, store, now });
  return { handlers, store, authenticate, now, rows };
}

function forecast(rows: ScheduleRow[], workspace = false, now = instant) {
  const schedules: LimitSchedule[] = rows
    .filter((saved) => saved.user_id === owner.id)
    .map((saved) => ({
      status: saved.status,
      rrule: saved.rrule,
      timezone: saved.timezone,
      to: saved.to,
      cc: saved.cc,
      bcc: saved.bcc,
      nextSendAt: new Date(saved.next_send_at),
    }));
  return JSON.parse(
    JSON.stringify(
      dailyLimitCheck(
        schedules,
        workspace ? "workspace" : "gmail.com",
        new Date(now),
      ),
    ),
  );
}

describe("Supabase schedule insert request", () => {
  it("uses only select in the query and supplies the owner in the body with the caller JWT", async () => {
    const saved = row();
    const { id, ...body } = saved;
    const fetcher = vi.fn().mockResolvedValue(Response.json([saved]));
    const store = createScheduleStore({
      url: "https://db.test",
      anonKey: "fake-anon",
      fetcher,
    });

    expect(await store.create(body, accessToken)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).pathname).toBe("/rest/v1/schedules");
    const params = new URL(url).searchParams;
    expect([...params]).toEqual([["select", expect.any(String)]]);
    expect(params.get("select")?.split(",").sort()).toEqual(
      Object.keys(saved).sort(),
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
    expect(init.headers).toMatchObject({
      apikey: "fake-anon",
      Authorization: `Bearer ${accessToken}`,
      Prefer: "return=representation",
    });
  });
});

describe("US-005 schedule input validation", () => {
  it("accepts a complete schedule with To, Cc, Bcc, RRULE and IANA timezone", () => {
    const valid = input({
      cc: ["copy@example.test"],
      bcc: ["blind@example.test"],
      timezone: "Europe/London",
    });
    expect(validateScheduleInput(valid)).toMatchObject(valid);
  });

  it("defaults optional recipients, HTML and source for a minimal schedule", () => {
    const { cc, bcc, body_html, source, ...minimal } = input();
    expect(validateScheduleInput(minimal)).toMatchObject({
      ...minimal,
      cc: [],
      bcc: [],
      body_html: null,
      source: "web",
    });
  });

  it.each(["web", "api", "cli", "mcp"] as const)(
    "accepts the %s source",
    (source) => {
      expect(validateScheduleInput(input({ source }))).toMatchObject({
        source,
      });
    },
  );

  it.each([1, 998])("accepts a %i-character subject", (length) => {
    const subject = "s".repeat(length);
    expect(validateScheduleInput(input({ subject }))).toMatchObject({
      subject,
    });
  });

  it.each(["body_text", "body_html"] as const)(
    "accepts empty and 100000-character %s",
    (field) => {
      for (const length of [0, 100000]) {
        const value = "b".repeat(length);
        expect(validateScheduleInput(input({ [field]: value }))).toMatchObject({
          [field]: value,
        });
      }
    },
  );

  it("accepts both bodies at their limits and optional null HTML", () => {
    const valid = input({
      subject: "s".repeat(998),
      body_text: "t".repeat(100000),
      body_html: "h".repeat(100000),
    });
    expect(validateScheduleInput(valid)).toMatchObject(valid);
    expect(validateScheduleInput(input({ body_html: null }))).toMatchObject({
      body_html: null,
    });
  });

  it.each([null, undefined, [], "schedule", 123])(
    "rejects a non-object payload %s",
    (payload) => {
      expect(() => validateScheduleInput(payload)).toThrow();
    },
  );

  it.each([
    ["missing To", { to: undefined }],
    ["empty To", { to: [] }],
    ["all empty recipients", { to: [], cc: [], bcc: [] }],
    ["string To", { to: "recipient@example.test" }],
    ["null Cc", { cc: null }],
    ["string Bcc", { bcc: "blind@example.test" }],
    ["empty subject", { subject: "" }],
    ["missing subject", { subject: undefined }],
    ["non-string subject", { subject: 123 }],
    ["999-character subject", { subject: "s".repeat(999) }],
    ["100001-character text", { body_text: "t".repeat(100001) }],
    ["100001-character HTML", { body_html: "h".repeat(100001) }],
    ["missing text", { body_text: undefined }],
    ["null text", { body_text: null }],
    ["non-string text", { body_text: 123 }],
    ["non-string HTML", { body_html: 123 }],
    ["unknown source", { source: "extension" }],
    ["empty source", { source: "" }],
    ["null source", { source: null }],
    ["non-string source", { source: 123 }],
    ["oversized source", { source: "web".repeat(1000) }],
    ["empty RRULE", { rrule: "" }],
    ["missing RRULE", { rrule: undefined }],
    ["invalid RRULE", { rrule: "not a rule" }],
    ["invalid frequency", { rrule: "FREQ=INVALID" }],
    ["zero interval", { rrule: "FREQ=DAILY;INTERVAL=0" }],
    ["invalid hour", { rrule: "FREQ=DAILY;BYHOUR=24" }],
    ["empty timezone", { timezone: "" }],
    ["missing timezone", { timezone: undefined }],
    ["invalid timezone", { timezone: "Mars/Olympus" }],
    ["non-string timezone", { timezone: 123 }],
  ])("rejects %s", (_label, changes) => {
    expect(() => validateScheduleInput({ ...input(), ...changes })).toThrow();
  });

  describe.each(["to", "cc", "bcc"] as const)("%s emails", (field) => {
    it.each([
      "",
      "not-an-email",
      "missing@",
      "@example.test",
      "a@@b.test",
      123,
      null,
    ])(
      "rejects an invalid address %s even alongside a valid address",
      (email) => {
        expect(() =>
          validateScheduleInput({
            ...input(),
            [field]: ["valid@example.test", email],
          }),
        ).toThrow();
      },
    );

    it("rejects CRLF header injection", () => {
      expect(() =>
        validateScheduleInput({
          ...input(),
          [field]: ["valid@example.test\r\nBcc: attacker@example.test"],
        }),
      ).toThrow();
    });
  });
});

describe("US-005 schedule HTTP handlers with injected persistence", () => {
  it("creates an active owner-bound schedule with a strictly future next send", async () => {
    const f = fixture();
    const response = await f.handlers.create(
      request("/api/schedules", "POST", {
        ...input(),
        user_id: "other",
        status: "paused",
        next_send_at: "2000-01-01T00:00:00Z",
      }),
    );
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.schedule).toMatchObject({
      ...input(),
      id: "created-schedule",
      user_id: owner.id,
      status: "active",
      next_send_at: nextSendAt,
    });
    expect(Date.parse(result.schedule.next_send_at)).toBeGreaterThan(instant);
    expect(f.rows).toEqual([result.schedule]);
    expect(f.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: owner.id, status: "active" }),
      accessToken,
    );
    expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
    expect(result.warning).toBeFalsy();
    expect(f.store.readConnection).toHaveBeenCalledWith(owner.id, accessToken);
  });

  it("sanitizes body_html on create and patch before persistence", async () => {
    const f = fixture([row()]);
    const unsafe =
      '<p onclick="evil()">Hi</p><script>evil()</script><a href="javascript:evil()">link</a>';
    const created = await f.handlers.create(
      request("/api/schedules", "POST", input({ body_html: unsafe })),
    );
    expect(created.status).toBe(201);
    expect(f.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ body_html: "<p>Hi</p><a>link</a>" }),
      accessToken,
    );

    const patched = await f.handlers.patch(
      request("/api/schedules/schedule-1", "PATCH", { body_html: unsafe }),
      "schedule-1",
    );
    expect(patched.status).toBe(200);
    expect(f.store.update).toHaveBeenCalledWith(
      owner.id,
      "schedule-1",
      expect.objectContaining({ body_html: "<p>Hi</p><a>link</a>" }),
      accessToken,
    );
  });

  it.each([
    [399, "ok", false],
    [400, "warn", true],
    [500, "warn", true],
    [501, "over", true],
  ] as const)(
    "returns the personal Gmail forecast and warning for %i daily recipients",
    async (count, status, warns) => {
      const f = fixture();
      const response = await f.handlers.create(
        request(
          "/api/schedules",
          "POST",
          input({
            to: Array.from(
              { length: count },
              (_, i) => `person${i}@example.test`,
            ),
          }),
        ),
      );
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
      expect(result.dailyLimitCheck).toMatchObject({
        count,
        limit: 500,
        status,
      });
      if (warns) expect(result.warning).toMatch(/gmail/i);
      else expect(result.warning).toBeFalsy();
    },
  );

  it.each([
    [false, "sender@company.test", 400, 500, "warn", true],
    [true, "sender@gmail.com", 400, 2000, "ok", false],
    [true, "sender@company.test", 501, 2000, "ok", false],
    [true, "sender@company.test", 1600, 2000, "warn", false],
    [true, "sender@company.test", 2001, 2000, "over", false],
  ] as const)(
    "uses is_workspace=%s with %s at %i deliveries",
    async (is_workspace, google_email, count, limit, status, personalWarning) => {
      const f = fixture([], { is_workspace, google_email });
      const response = await f.handlers.create(
        request(
          "/api/schedules",
          "POST",
          input({
            to: Array.from(
              { length: count },
              (_, i) => `person${i}@example.test`,
            ),
          }),
        ),
      );
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.dailyLimitCheck).toEqual(forecast(f.rows, is_workspace));
      expect(result.dailyLimitCheck).toMatchObject({ count, limit, status });
      if (personalWarning) expect(result.warning).toMatch(/gmail/i);
      else
        expect(result.warning ?? "").not.toMatch(
          /personal.*gmail|gmail.*personal/i,
        );
    },
  );

  it("forecasts all active owner schedules and every To/Cc/Bcc entry", async () => {
    const f = fixture([
      row({
        to: Array.from({ length: 397 }, (_, i) => `old${i}@example.test`),
      }),
      row({
        id: "paused",
        status: "paused",
        to: Array(500).fill("p@example.test"),
      }),
      row({
        id: "foreign",
        user_id: "other",
        to: Array(500).fill("x@example.test"),
      }),
    ]);
    const response = await f.handlers.create(
      request(
        "/api/schedules",
        "POST",
        input({
          cc: ["copy@example.test"],
          bcc: ["blind@example.test"],
        }),
      ),
    );
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
    expect(result.dailyLimitCheck).toMatchObject({
      count: 400,
      status: "warn",
    });
    expect(result.warning).toMatch(/gmail/i);
  });

  it("lists only the authenticated owner's schedules", async () => {
    const own = row();
    const foreign = row({ id: "foreign", user_id: "other" });
    const f = fixture([own, foreign]);
    const response = await f.handlers.list(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schedules: [own] });
    expect(f.store.list).toHaveBeenCalledWith(owner.id, accessToken);
  });

  it("gets an owner schedule and hides another owner's ID as missing", async () => {
    const own = row();
    const f = fixture([own, row({ id: "foreign", user_id: "other" })]);
    const response = await f.handlers.get(
      request("/api/schedules/schedule-1"),
      own.id,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schedule: own });
    expect(f.store.get).toHaveBeenCalledWith(owner.id, own.id, accessToken);
    for (const id of ["foreign", "missing"]) {
      const hidden = await f.handlers.get(request(`/api/schedules/${id}`), id);
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).not.toContain('"user_id":"other"');
    }
  });

  it.each([
    [
      { rrule: "FREQ=DAILY;BYHOUR=12;BYMINUTE=0;BYSECOND=0" },
      "2026-07-01T12:00:00.000Z",
    ],
    [{ timezone: "America/New_York" }, "2026-07-01T13:00:00.000Z"],
  ])(
    "patches recurrence fields %s and recomputes next_send_at",
    async (changes, expected) => {
      const original = row();
      const f = fixture([original]);
      const response = await f.handlers.patch(
        request("/api/schedules/schedule-1", "PATCH", changes),
        original.id,
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.schedule).toMatchObject({
        ...original,
        ...changes,
        next_send_at: expected,
        updated_at: new Date(instant).toISOString(),
      });
      expect(Date.parse(result.schedule.next_send_at)).toBeGreaterThan(instant);
      expect(f.rows[0]).toEqual(result.schedule);
      expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
      expect(f.store.update).toHaveBeenCalledWith(
        owner.id,
        original.id,
        expect.objectContaining({ next_send_at: expected }),
        accessToken,
      );
    },
  );

  it("replaces the patched schedule in the forecast without counting it twice", async () => {
    const f = fixture([row()]);
    const response = await f.handlers.patch(
      request("/api/schedules/schedule-1", "PATCH", {
        to: Array.from({ length: 400 }, (_, i) => `person${i}@example.test`),
      }),
      "schedule-1",
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
    expect(result.dailyLimitCheck.count).toBe(400);
    expect(result.warning).toMatch(/gmail/i);
    expect(f.rows).toHaveLength(1);
  });

  it.each([
    { subject: "" },
    { subject: "s".repeat(999) },
    { to: [] },
    { cc: ["invalid"] },
    { bcc: ["invalid"] },
    { rrule: "FREQ=BAD" },
    { timezone: "Invalid/Zone" },
    { body_text: "t".repeat(100001) },
    { body_html: "h".repeat(100001) },
    { source: "unknown" },
  ])(
    "rejects invalid create and patch input without persisting: %s",
    async (changes) => {
      const original = row();
      const f = fixture([original]);
      const created = await f.handlers.create(
        request("/api/schedules", "POST", { ...input(), ...changes }),
      );
      const patched = await f.handlers.patch(
        request("/api/schedules/schedule-1", "PATCH", changes),
        original.id,
      );
      expect(created.status).toBe(400);
      expect(patched.status).toBe(400);
      expect(f.store.create).not.toHaveBeenCalled();
      expect(f.store.update).not.toHaveBeenCalled();
      expect(f.rows).toEqual([original]);
    },
  );

  it("does not allow patch to transfer ownership or overwrite server-controlled fields", async () => {
    const original = row();
    const f = fixture([original]);
    const response = await f.handlers.patch(
      request("/api/schedules/schedule-1", "PATCH", {
        subject: "Updated reminder",
        user_id: "other",
        id: "forged",
        status: "sending",
        next_send_at: "2000-01-01T00:00:00Z",
      }),
      original.id,
    );
    expect(response.status).toBe(200);
    expect(f.rows[0]).toMatchObject({
      id: original.id,
      user_id: owner.id,
      status: "active",
      subject: "Updated reminder",
    });
    expect(Date.parse(f.rows[0].next_send_at)).toBeGreaterThan(instant);
  });

  it("deletes only the addressed owner's schedule", async () => {
    const foreign = row({ id: "foreign", user_id: "other" });
    const f = fixture([row(), foreign]);
    const response = await f.handlers.delete(
      request("/api/schedules/schedule-1", "DELETE"),
      "schedule-1",
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(f.rows).toEqual([foreign]);
    expect(f.store.delete).toHaveBeenCalledWith(
      owner.id,
      "schedule-1",
      accessToken,
    );
  });

  it("pauses then resumes with a new future send computed at the injected current time", async () => {
    const f = fixture([row()]);
    const paused = await f.handlers.pause(
      request("/api/schedules/schedule-1/pause", "POST"),
      "schedule-1",
    );
    expect(paused.status).toBe(200);
    expect((await paused.json()).schedule.status).toBe("paused");
    expect(f.rows[0].status).toBe("paused");
    const later = Date.parse("2026-07-04T10:00:00Z");
    f.now.mockReturnValue(later);
    const resumed = await f.handlers.resume(
      request("/api/schedules/schedule-1/resume", "POST"),
      "schedule-1",
    );
    expect(resumed.status).toBe(200);
    const result = await resumed.json();
    expect(result.schedule).toMatchObject({
      status: "active",
      next_send_at: "2026-07-05T09:00:00.000Z",
    });
    expect(Date.parse(result.schedule.next_send_at)).toBeGreaterThan(later);
    expect(f.rows[0]).toEqual(result.schedule);
    expect(result.dailyLimitCheck).toEqual(forecast(f.rows, false, later));
  });

  it("returns a personal Gmail warning when resuming crosses the 400 threshold", async () => {
    const f = fixture([
      row({
        to: Array.from({ length: 399 }, (_, i) => `person${i}@example.test`),
      }),
      row({ id: "paused", status: "paused" }),
    ]);
    const response = await f.handlers.resume(
      request("/api/schedules/paused/resume", "POST"),
      "paused",
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.dailyLimitCheck).toEqual(forecast(f.rows));
    expect(result.dailyLimitCheck).toMatchObject({
      count: 400,
      status: "warn",
    });
    expect(result.warning).toMatch(/gmail/i);
  });

  it("pauses all active owner schedules while leaving other owners untouched", async () => {
    const foreign = row({ id: "foreign", user_id: "other" });
    const f = fixture([
      row(),
      row({ id: "second" }),
      row({ id: "paused", status: "paused" }),
      foreign,
    ]);
    const response = await f.handlers.pauseAll(
      request("/api/schedules/pause-all", "POST"),
    );
    expect(response.status).toBe(200);
    expect(
      f.rows
        .filter((saved) => saved.user_id === owner.id)
        .map((saved) => saved.status),
    ).toEqual(["paused", "paused", "paused"]);
    expect(f.rows.find((saved) => saved.id === foreign.id)).toEqual(foreign);
    expect(f.store.pauseAll).toHaveBeenCalledWith(owner.id, accessToken);
  });

  it.each(["patch", "delete", "pause", "resume"] as const)(
    "hides foreign and nonexistent schedules during %s without changing data",
    async (operation) => {
      const foreign = row({ id: "foreign", user_id: "other" });
      const f = fixture([row(), foreign]);
      const before = structuredClone(f.rows);
      for (const id of ["foreign", "missing"]) {
        const method =
          operation === "patch"
            ? "PATCH"
            : operation === "delete"
              ? "DELETE"
              : "POST";
        const response = await f.handlers[operation](
          request(
            `/api/schedules/${id}`,
            method,
            operation === "patch" ? { subject: "Changed" } : undefined,
          ),
          id,
        );
        expect(response.status).toBe(404);
      }
      expect(f.rows).toEqual(before);
      expect(f.store.update).not.toHaveBeenCalled();
      expect(f.store.delete).not.toHaveBeenCalled();
    },
  );

  it("returns history only after confirming the schedule belongs to the caller", async () => {
    const f = fixture([row()]);
    const record = {
      id: "send-1",
      scheduled_for: nextSendAt,
      attempted_at: nextSendAt,
      status: "failed" as const,
      error_code: "invalid_grant",
    };
    vi.mocked(f.store.history).mockResolvedValue([record]);

    const response = await f.handlers.history(
      request("/api/schedules/schedule-1/history"),
      "schedule-1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ history: [record] });
    expect(f.store.history).toHaveBeenCalledWith(
      owner.id,
      "schedule-1",
      accessToken,
    );

    const foreign = fixture([row({ id: "foreign", user_id: "other" })]);
    const missing = await foreign.handlers.history(
      request("/api/schedules/foreign/history"),
      "foreign",
    );
    expect(missing.status).toBe(404);
    expect(foreign.store.history).not.toHaveBeenCalled();
  });
});

const operations = [
  ["list", "GET", "/api/schedules"],
  ["create", "POST", "/api/schedules"],
  ["get", "GET", "/api/schedules/schedule-1"],
  ["patch", "PATCH", "/api/schedules/schedule-1"],
  ["delete", "DELETE", "/api/schedules/schedule-1"],
  ["pause", "POST", "/api/schedules/schedule-1/pause"],
  ["resume", "POST", "/api/schedules/schedule-1/resume"],
  ["pauseAll", "POST", "/api/schedules/pause-all"],
  ["history", "GET", "/api/schedules/schedule-1/history"],
] as const;

describe("US-005 schedule authentication and mutation origins", () => {
  it.each(operations)(
    "requires authentication for %s",
    async (operation, method, path) => {
      const f = fixture([row()]);
      f.authenticate.mockResolvedValue(null);
      const before = structuredClone(f.rows);
      const response = await f.handlers[operation](
        request(
          path,
          method,
          method === "POST" || method === "PATCH" ? input() : undefined,
        ),
        "schedule-1",
      );
      expect(response.status).toBe(401);
      expect(f.rows).toEqual(before);
      for (const spy of Object.values(f.store))
        expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each(operations.filter(([, method]) => method !== "GET"))(
    "rejects missing, null and cross-origin requests for %s",
    async (operation, method, path) => {
      const f = fixture([row()]);
      const before = structuredClone(f.rows);
      for (const attacker of [
        null,
        "",
        "null",
        "https://attacker.test",
        "https://app.test.attacker.test",
        "http://app.test",
      ]) {
        const response = await f.handlers[operation](
          request(
            path,
            method,
            method === "POST" || method === "PATCH" ? input() : undefined,
            attacker,
          ),
          "schedule-1",
        );
        expect(response.status).toBe(403);
      }
      expect(f.rows).toEqual(before);
      for (const spy of Object.values(f.store))
        expect(spy).not.toHaveBeenCalled();
    },
  );
});
