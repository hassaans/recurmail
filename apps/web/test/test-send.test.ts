import { describe, expect, it, vi } from "vitest";
import { encryptRefreshToken } from "../lib/crypto";
import type { Identity } from "../lib/gmail-flow";
import { GmailSendError, GoogleTokenError } from "../lib/google";
import {
  createTestSendHandler,
  createTestSendStore,
  resolveTestSender,
  type TestSender,
  type TestSendStore,
} from "../lib/test-send";

const origin = "https://app.test";
const key = Buffer.alloc(32, 7).toString("base64");
const owner = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "me@example.test",
};
const otherUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "other@example.test",
};
const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherConnectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const accessToken = "fake-session-access";
const instant = Date.parse("2026-07-01T09:00:00Z");

function sender(overrides: Partial<TestSender> = {}): TestSender {
  return {
    email: "sender@gmail.com",
    is_workspace: false,
    status: "connected",
    encrypted_refresh_token: encryptRefreshToken("fake-refresh", key, owner.id),
    ...overrides,
  };
}

function request(body: unknown, requestOrigin: string | null = origin) {
  return new Request(`${origin}/api/schedules/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(requestOrigin !== null ? { Origin: requestOrigin } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Weekly check-in",
    body_text: "Hello team",
    body_html: "<p>Hello <strong>team</strong></p>",
    ...overrides,
  };
}

/** A fake store with the same ownership rules as the real PostgREST queries. */
function fakeStore(
  options: { connection?: TestSender | null; used?: number } = {},
) {
  const rows: string[] = Array.from({ length: options.used ?? 0 }, () =>
    new Date(instant - 60000).toISOString(),
  );
  const connection =
    options.connection === undefined ? sender() : options.connection;
  const store: TestSendStore = {
    findConnection: vi.fn(async (userId: string, id?: string) => {
      if (userId !== owner.id) return null;
      if (id !== undefined && id !== connectionId) return null;
      return connection;
    }),
    countSince: vi.fn(async (userId: string, since: string) =>
      userId === owner.id ? rows.filter((at) => at >= since).length : 0,
    ),
    record: vi.fn(async (_userId: string, at: string) => {
      rows.push(at);
    }),
  };
  return store;
}

function fakeGoogle(options: { refresh?: Error; send?: Error } = {}): {
  refreshAccessToken: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    refreshAccessToken: vi.fn(async (refreshToken: string) => {
      if (options.refresh) throw options.refresh;
      expect(refreshToken).toBe("fake-refresh");
      return "fake-gmail-access";
    }),
    sendMessage: vi.fn(async () => {
      if (options.send) throw options.send;
    }),
  };
}

function handler(
  store: TestSendStore,
  google = fakeGoogle(),
  identity: Identity | null = { user: owner, accessToken },
) {
  return createTestSendHandler({
    origin,
    key,
    authenticate: vi.fn(async () => identity),
    google,
    store,
    now: () => instant,
  });
}

function decodeRaw(raw: string) {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const [block, ...rest] = message.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers[line.slice(0, colon).toLowerCase()] = line
        .slice(colon + 1)
        .trim();
  }
  return { headers, body: rest.join("\r\n\r\n") };
}

function decodedParts(body: string): string[] {
  return body
    .split(/--recurmail_alternative(?:--)?/)
    .map((part) => part.split("\r\n\r\n").slice(1).join(""))
    .filter(Boolean)
    .map((encoded) =>
      Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8"),
    );
}

describe("POST /api/schedules/test", () => {
  it("sends the draft to the signed-in user only with a [Test] subject and records it", async () => {
    const store = fakeStore();
    const google = fakeGoogle();
    const response = await handler(store, google)(request(draft()));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ sent_to: owner.email });
    expect(google.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(google.sendMessage).toHaveBeenCalledTimes(1);
    const [token, raw] = google.sendMessage.mock.calls[0];
    expect(token).toBe("fake-gmail-access");
    const { headers, body } = decodeRaw(raw);
    expect(headers.to).toBe(owner.email);
    expect(headers.from).toBe("sender@gmail.com");
    expect(headers.subject).toBe("[Test] Weekly check-in");
    expect(headers.cc).toBeUndefined();
    expect(headers.bcc).toBeUndefined();
    expect(decodedParts(body)).toEqual([
      "Hello team",
      "<p>Hello <strong>team</strong></p>",
    ]);
    expect(store.record).toHaveBeenCalledWith(
      owner.id,
      new Date(instant).toISOString(),
    );
  });

  it("sanitizes the draft HTML with the schedule sanitizer before sending", async () => {
    const google = fakeGoogle();
    const response = await handler(
      fakeStore(),
      google,
    )(
      request(
        draft({
          body_html:
            '<p onclick="evil()">Hi</p><script>evil()</script><a href="javascript:evil()">link</a>',
        }),
      ),
    );
    expect(response.status).toBe(200);
    const { body } = decodeRaw(google.sendMessage.mock.calls[0][1]);
    expect(decodedParts(body)[1]).toBe("<p>Hi</p><a>link</a>");
  });

  it("ignores any recipients in the request body", async () => {
    const google = fakeGoogle();
    const response = await handler(
      fakeStore(),
      google,
    )(
      request(
        draft({
          to: ["boss@example.test"],
          cc: ["cc@example.test"],
          bcc: ["bcc@example.test"],
        }),
      ),
    );
    expect(response.status).toBe(200);
    const raw: string = google.sendMessage.mock.calls[0][1];
    const { headers } = decodeRaw(raw);
    expect(headers.to).toBe(owner.email);
    expect(headers.cc).toBeUndefined();
    expect(headers.bcc).toBeUndefined();
    expect(Buffer.from(raw, "base64url").toString("utf8")).not.toMatch(
      /boss@example\.test|cc@example\.test|bcc@example\.test/,
    );
  });

  it("applies the same subject and body validation as saving", async () => {
    const store = fakeStore();
    const google = fakeGoogle();
    const send = handler(store, google);
    const cases: [unknown, string][] = [
      [draft({ subject: "" }), "subject must be a string"],
      [draft({ subject: "line\nbreak" }), "control characters"],
      [draft({ body_text: 42 }), "body_text must be a string"],
      [draft({ body_html: "x".repeat(100001) }), "body_html must be a string"],
      [
        draft({ gmail_connection_id: 7 }),
        "gmail_connection_id must be a string",
      ],
      [[], "Expected a JSON object"],
      ["{not json", "Malformed JSON"],
    ];
    for (const [body, message] of cases) {
      const response = await send(request(body));
      expect(response.status, message).toBe(400);
      const result = await response.json();
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message).toContain(message);
    }
    expect(google.sendMessage).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and unauthenticated requests before touching storage", async () => {
    const store = fakeStore();
    const crossOrigin = await handler(store)(
      request(draft(), "https://attacker.test"),
    );
    expect(crossOrigin.status).toBe(403);
    const missingOrigin = await handler(store)(request(draft(), null));
    expect(missingOrigin.status).toBe(403);
    const signedOut = await handler(
      store,
      fakeGoogle(),
      null,
    )(request(draft()));
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).error.code).toBe("unauthenticated");
    expect(store.findConnection).not.toHaveBeenCalled();
  });

  it("returns 429 with a retry time on the 6th test in a rolling hour", async () => {
    const store = fakeStore();
    const google = fakeGoogle();
    const send = handler(store, google);
    for (let index = 0; index < 5; index += 1) {
      const response = await send(request(draft()));
      expect(response.status, `test ${index + 1}`).toBe(200);
    }
    const sixth = await send(request(draft()));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBe("3600");
    const result = await sixth.json();
    expect(result.error.code).toBe("rate_limited");
    expect(result.error.message).toBe(
      "You've sent 5 test emails in the last hour. Try again at 10:00 AM UTC.",
    );
    expect(result.error.retry_at).toBe("2026-07-01T10:00:00.000Z");
    expect(google.sendMessage).toHaveBeenCalledTimes(5);
    expect(store.record).toHaveBeenCalledTimes(5);
  });

  it("does not count tests older than an hour toward the limit", async () => {
    const stale: TestSendStore = {
      ...fakeStore(),
      countSince: vi.fn(async (_userId: string, since: string) => {
        expect(since).toBe("2026-07-01T08:00:00.000Z");
        return 0;
      }),
    };
    const response = await handler(stale)(request(draft()));
    expect(response.status).toBe(200);
  });

  it("asks the user to reconnect on invalid_grant and writes nothing", async () => {
    const store = fakeStore();
    const google = fakeGoogle({
      refresh: new GoogleTokenError("invalid_grant"),
    });
    const response = await handler(store, google)(request(draft()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "gmail_reconnect_required",
        message:
          "Gmail access for sender@gmail.com has expired. Reconnect it from the dashboard.",
      },
    });
    expect(google.sendMessage).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });

  it("answers 502 when Gmail fails and records nothing", async () => {
    const store = fakeStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const google = fakeGoogle({ send: new GmailSendError(500) });
      const response = await handler(store, google)(request(draft()));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "gmail_send_failed",
          message: "Gmail couldn't send the test email. Try again in a moment.",
        },
      });
      expect(store.record).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("[ERROR] test_send_gmail_failed");
    } finally {
      error.mockRestore();
    }
  });

  it("requires a connected Gmail account", async () => {
    for (const connection of [null, sender({ status: "needs_reconnect" })]) {
      const store = fakeStore({ connection });
      const google = fakeGoogle();
      const response = await handler(store, google)(request(draft()));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "gmail_not_connected", message: "Connect Gmail first" },
      });
      expect(google.refreshAccessToken).not.toHaveBeenCalled();
      expect(store.record).not.toHaveBeenCalled();
    }
  });

  it("rejects a gmail_connection_id that belongs to another user", async () => {
    const store = fakeStore();
    const google = fakeGoogle();
    const send = handler(store, google);
    const foreign = await send(
      request(draft({ gmail_connection_id: otherConnectionId })),
    );
    expect(foreign.status).toBe(409);
    expect((await foreign.json()).error.code).toBe("gmail_not_connected");
    expect(store.findConnection).toHaveBeenCalledWith(
      owner.id,
      otherConnectionId,
    );
    const malformed = await send(
      request(draft({ gmail_connection_id: "not-a-uuid" })),
    );
    expect(malformed.status).toBe(409);
    expect(google.refreshAccessToken).not.toHaveBeenCalled();
    const own = await send(
      request(draft({ gmail_connection_id: connectionId })),
    );
    expect(own.status).toBe(200);
    expect(store.findConnection).toHaveBeenLastCalledWith(
      owner.id,
      connectionId,
    );
  });

  it("fails closed with a code-only log on unexpected errors", async () => {
    const store: TestSendStore = {
      ...fakeStore(),
      countSince: vi.fn(async () => {
        throw new Error("fake-secret-connection-string");
      }),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handler(store)(request(draft()));
      expect(response.status).toBe(500);
      expect((await response.json()).error.code).toBe("internal_error");
      expect(error).toHaveBeenCalledWith("[ERROR] test_send_failed");
      expect(JSON.stringify(error.mock.calls)).not.toContain("fake-secret");
    } finally {
      error.mockRestore();
    }
  });
});

describe("resolveTestSender", () => {
  it("returns the user's single connection and verifies ownership of an explicit id", async () => {
    const connection = sender();
    const store = fakeStore({ connection });
    await expect(resolveTestSender(owner.id, undefined, store)).resolves.toBe(
      connection,
    );
    await expect(
      resolveTestSender(owner.id, connectionId, store),
    ).resolves.toBe(connection);
    await expect(
      resolveTestSender(owner.id, otherConnectionId, store),
    ).resolves.toBeNull();
    await expect(
      resolveTestSender(otherUser.id, connectionId, store),
    ).resolves.toBeNull();
    await expect(
      resolveTestSender(owner.id, "' or 1=1", store),
    ).resolves.toBeNull();
    expect(store.findConnection).not.toHaveBeenCalledWith(owner.id, "' or 1=1");
  });
});

describe("test send store", () => {
  it("uses the service role to scope every query to the user and only writes test_sends", async () => {
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/rest/v1/gmail_connections")
        return Response.json([
          {
            id: connectionId,
            google_email: "sender@gmail.com",
            is_workspace: true,
            status: "connected",
            encrypted_refresh_token: "ciphertext",
          },
        ]);
      if (url.pathname === "/rest/v1/test_sends" && init.method === "GET")
        return Response.json([{ sent_at: "2026-07-01T08:30:00.000Z" }]);
      if (url.pathname === "/rest/v1/test_sends" && init.method === "POST")
        return new Response(null, { status: 201 });
      throw new Error(`unexpected ${init.method} ${input}`);
    });
    const store = createTestSendStore({
      url: "https://fake-project.supabase.test",
      secretKey: "fake-secret-key",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(store.findConnection(owner.id, connectionId)).resolves.toEqual(
      {
        email: "sender@gmail.com",
        is_workspace: true,
        status: "connected",
        encrypted_refresh_token: "ciphertext",
      },
    );
    await expect(
      store.countSince(owner.id, "2026-07-01T08:00:00.000Z"),
    ).resolves.toBe(1);
    await store.record(owner.id, "2026-07-01T09:00:00.000Z");
    const calls = fetcher.mock.calls.map(([input, init]) => ({
      url: new URL(input),
      init,
    }));
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      "/rest/v1/gmail_connections",
      "/rest/v1/test_sends",
      "/rest/v1/test_sends",
    ]);
    expect(calls[0].url.searchParams.get("user_id")).toBe(`eq.${owner.id}`);
    expect(calls[0].url.searchParams.get("id")).toBe(`eq.${connectionId}`);
    expect(calls[0].url.searchParams.get("select")).toBe(
      "id,google_email,is_workspace,status,encrypted_refresh_token",
    );
    expect(calls[1].url.searchParams.get("user_id")).toBe(`eq.${owner.id}`);
    expect(calls[1].url.searchParams.get("sent_at")).toBe(
      "gte.2026-07-01T08:00:00.000Z",
    );
    expect(calls[2].init.body).toBe(
      JSON.stringify({
        user_id: owner.id,
        sent_at: "2026-07-01T09:00:00.000Z",
      }),
    );
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>;
      expect(headers.apikey).toBe("fake-secret-key");
      expect(headers.Authorization).toBeUndefined();
    }
    expect((calls[2].init.headers as Record<string, string>).Prefer).toBe(
      "return=minimal",
    );
  });

  it("surfaces storage failures without leaking the response", async () => {
    const store = createTestSendStore({
      url: "https://fake-project.supabase.test",
      secretKey: "fake-secret-key",
      fetcher: vi.fn(async () =>
        Response.json({ message: "fake-secret-detail" }, { status: 500 }),
      ) as unknown as typeof fetch,
    });
    await expect(
      store.countSince(owner.id, "2026-07-01T08:00:00.000Z"),
    ).rejects.toThrow("Test send storage failed: count_test_sends");
    await expect(store.findConnection(owner.id)).rejects.toThrow(
      "Test send storage failed: read_connection",
    );
  });
});
