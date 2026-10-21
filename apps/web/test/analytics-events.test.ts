import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsEventRow } from "../lib/analytics-events";
import {
  cleanProperties,
  isBotUserAgent,
  validateClientEvent,
} from "../lib/analytics-events";
import {
  CLIENT_EVENT_BUDGET,
  createEventsHandler,
  readLimitedText,
} from "../lib/analytics-server";
import type { AnalyticsStore, ClientEventBudget } from "../lib/analytics-store";

const origin = "https://app.test";
const anonymousId = "a0000000-0000-4000-8000-000000000001";
const sessionId = "b0000000-0000-4000-8000-000000000001";
const browser =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    event: "page_view",
    anonymous_id: anonymousId,
    session_id: sessionId,
    path: "/guides/recurring-email-gmail",
    referrer_host: "reddit.com",
    utm_source: "reddit",
    utm_medium: "social",
    source: "ignored-by-the-server",
    device: "desktop",
    properties: {},
    ...overrides,
  };
}

describe("browser event validation", () => {
  it("accepts a page view and derives the source itself", () => {
    expect(validateClientEvent(payload())).toEqual({
      event: "page_view",
      anonymous_id: anonymousId,
      session_id: sessionId,
      path: "/guides/recurring-email-gmail",
      referrer_host: "reddit.com",
      source: "reddit",
      utm_source: "reddit",
      utm_medium: "social",
      device: "desktop",
      properties: {},
    });
    expect(
      validateClientEvent(
        payload({ utm_source: undefined, referrer_host: "t.co" }),
      )?.source,
    ).toBe("x");
    expect(
      validateClientEvent({
        event: "cta_click",
        properties: { location: "hero" },
      }),
    ).toMatchObject({
      event: "cta_click",
      anonymous_id: null,
      session_id: null,
      path: null,
      source: "direct",
      device: null,
      properties: { location: "hero" },
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown event", { event: "signup_completed" }],
    ["a server-only event", { event: "schedule_created" }],
    ["a missing event", { event: undefined }],
    ["a bad browser id", { anonymous_id: "visitor-1" }],
    ["a bad session id", { session_id: 12 }],
    ["a bad device", { device: "phone" }],
    ["array properties", { properties: ["a"] }],
    ["nested properties", { properties: { nested: { a: 1 } } }],
    ["a property key with a dash", { properties: { "bad-key": 1 } }],
    ["a property value with a newline", { properties: { note: "a\nb" } }],
    [
      "too many properties",
      {
        properties: Object.fromEntries(
          Array.from({ length: 13 }, (_, i) => [`k${i}`, i]),
        ),
      },
    ],
    ["a long property", { properties: { label: "x".repeat(201) } }],
  ])("rejects %s", (_label, overrides) => {
    expect(validateClientEvent(payload(overrides))).toBeNull();
  });

  it("rejects non-object payloads", () => {
    for (const value of [null, "page_view", 1, [], undefined])
      expect(validateClientEvent(value)).toBeNull();
  });

  it("drops the query string from a path and ignores unknown fields", () => {
    const event = validateClientEvent(
      payload({ path: "/auth/callback?code=fake-secret-code", email: "x@y.z" }),
    );
    expect(event?.path).toBe("/auth/callback");
    expect(JSON.stringify(event)).not.toContain("fake-secret-code");
    expect(JSON.stringify(event)).not.toContain("x@y.z");
  });

  it("keeps flat string, number and boolean properties", () => {
    expect(
      cleanProperties({ depth: 25, location: "hero", retry: true }),
    ).toEqual({
      depth: 25,
      location: "hero",
      retry: true,
    });
    expect(cleanProperties(undefined)).toEqual({});
    expect(cleanProperties({ depth: Number.NaN })).toBeNull();
    expect(cleanProperties({ when: new Date() })).toBeNull();
  });

  it("tells crawlers and scripts from browsers", () => {
    expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(
      true,
    );
    expect(isBotUserAgent("curl/8.4.0")).toBe(true);
    expect(isBotUserAgent("python-requests/2.31")).toBe(true);
    expect(isBotUserAgent("HeadlessChrome/130.0")).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent(browser)).toBe(false);
    expect(
      isBotUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36",
      ),
    ).toBe(false);
  });
});

describe("POST /api/events", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function fixture(user: { id: string; email: string | null } | null = null) {
    const store = {
      insertEvent: vi.fn(async (_row: AnalyticsEventRow) => {}),
      recordClientEvent: vi.fn(
        async (_row: AnalyticsEventRow, _budget: ClientEventBudget) => true,
      ),
      hasAttribution: vi.fn(async () => false),
      insertAttribution: vi.fn(async () => {}),
      summary: vi.fn(async () => ({})),
    } satisfies AnalyticsStore;
    const handler = createEventsHandler({
      origin,
      store,
      identity: vi.fn(() => user),
    });
    return { store, handler };
  }

  function request(
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) {
    return new Request(`${origin}/api/events`, {
      method,
      headers: {
        Origin: origin,
        "User-Agent": browser,
        "Accept-Language": "en-US,en;q=0.8",
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }

  it("records a valid event with the request details and answers 204", async () => {
    const f = fixture();
    const response = await f.handler(
      request(payload(), {
        "x-forwarded-for": "198.51.100.7",
        "x-vercel-ip-country": "PK",
        "x-vercel-ip-country-region": "PB",
        "x-vercel-ip-city": "Lahore",
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.store.recordClientEvent).toHaveBeenCalledWith(
      {
        event: "page_view",
        anonymous_id: anonymousId,
        session_id: sessionId,
        user_id: null,
        user_email: null,
        path: "/guides/recurring-email-gmail",
        referrer_host: "reddit.com",
        source: "reddit",
        utm_source: "reddit",
        utm_medium: "social",
        device: "desktop",
        ip_address: "198.51.100.7",
        user_agent: browser,
        accept_language: "en-US,en;q=0.8",
        country: "PK",
        region: "PB",
        city: "Lahore",
        is_bot: false,
        properties: {},
      },
      CLIENT_EVENT_BUDGET,
    );
    expect(f.store.insertEvent).not.toHaveBeenCalled();
  });

  it("answers 429 without storing when the address has spent its budget", async () => {
    const f = fixture();
    f.store.recordClientEvent.mockResolvedValueOnce(false);
    const response = await f.handler(
      request(payload(), { "x-forwarded-for": "198.51.100.7" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.store.recordClientEvent.mock.calls[0][0]).toMatchObject({
      ip_address: "198.51.100.7",
    });
  });

  it("attaches the signed-in user and ignores a malformed country or address", async () => {
    const f = fixture({
      id: "00000000-0000-4000-8000-000000000051",
      email: "owner@gmail.com",
    });
    await f.handler(
      request(payload(), {
        "x-vercel-ip-country": "pakistan",
        "x-forwarded-for": "not-an-address",
      }),
    );
    expect(f.store.recordClientEvent.mock.calls[0][0]).toMatchObject({
      user_id: "00000000-0000-4000-8000-000000000051",
      user_email: "owner@gmail.com",
      country: null,
      ip_address: null,
    });
  });

  it("refuses cross-site, missing-origin and non-POST requests without storing anything", async () => {
    const f = fixture();
    expect(
      (await f.handler(request(payload(), { Origin: "https://attacker.test" })))
        .status,
    ).toBe(403);
    const noOrigin = new Request(`${origin}/api/events`, {
      method: "POST",
      headers: { "User-Agent": browser },
      body: JSON.stringify(payload()),
    });
    expect((await f.handler(noOrigin)).status).toBe(403);
    expect((await f.handler(request(undefined, {}, "GET"))).status).toBe(405);
    expect(f.store.recordClientEvent).not.toHaveBeenCalled();
  });

  it("keeps crawler traffic, flagged as a bot", async () => {
    const f = fixture();
    const response = await f.handler(
      request(payload(), {
        "User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0)",
      }),
    );
    expect(response.status).toBe(204);
    expect(f.store.recordClientEvent.mock.calls[0][0]).toMatchObject({
      is_bot: true,
      user_agent: "Mozilla/5.0 (compatible; bingbot/2.0)",
    });
  });

  it("rejects malformed and invalid events", async () => {
    const f = fixture();
    expect((await f.handler(request("{not json"))).status).toBe(400);
    expect(
      (await f.handler(request(payload({ event: "signup_completed" })))).status,
    ).toBe(400);
    expect(
      (await f.handler(request(payload({ anonymous_id: "me" })))).status,
    ).toBe(400);
    expect(
      (await f.handler(request(payload({ properties: { email: { x: 1 } } }))))
        .status,
    ).toBe(400);
    expect((await f.handler(request("x".repeat(9000)))).status).toBe(413);
    expect(
      (await f.handler(request(payload(), { "Content-Length": "50000000" })))
        .status,
    ).toBe(413);
    expect(f.store.recordClientEvent).not.toHaveBeenCalled();
  });

  it("still answers 204 when storage fails, logging a safe event", async () => {
    const f = fixture();
    f.store.recordClientEvent.mockRejectedValueOnce(
      new Error("fake-secret upstream"),
    );
    const response = await f.handler(request(payload()));
    expect(response.status).toBe(204);
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] analytics_insert_failed",
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "fake-secret",
    );
  });
});

describe("reading a bounded body", () => {
  /** A body that never ends, counting how many chunks were pulled from it. */
  function endless(chunk: Uint8Array) {
    const stream = {
      pulls: 0,
      cancelled: false,
      body: null as unknown as ReadableStream<Uint8Array>,
    };
    stream.body = new ReadableStream<Uint8Array>({
      pull(controller) {
        stream.pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        stream.cancelled = true;
      },
    });
    return stream;
  }
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request(`${origin}/api/events`, {
      method: "POST",
      body,
      headers,
      duplex: "half",
    } as RequestInit);

  it("stops reading an undeclared body as soon as it passes the limit", async () => {
    const stream = endless(new Uint8Array(1024).fill(120));
    await expect(readLimitedText(post(stream.body), 8192)).resolves.toBeNull();
    expect(stream.pulls).toBeLessThanOrEqual(12);
    expect(stream.cancelled).toBe(true);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const stream = endless(new Uint8Array(1024));
    await expect(
      readLimitedText(post(stream.body, { "Content-Length": "9000" }), 8192),
    ).resolves.toBeNull();
    expect(stream.pulls).toBeLessThanOrEqual(1);
  });

  it("returns a body within the limit, multi-byte text intact", async () => {
    const text = JSON.stringify({
      campaign: "lancement d'\u00e9t\u00e9 \u6f22",
    });
    await expect(readLimitedText(post(text), 8192)).resolves.toBe(text);
    const bytes = new TextEncoder().encode(text);
    // Split inside a multi-byte character.
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 3));
        controller.enqueue(bytes.slice(bytes.length - 3));
        controller.close();
      },
    });
    await expect(readLimitedText(post(split), 8192)).resolves.toBe(text);
    await expect(
      readLimitedText(post("x".repeat(8193)), 8192),
    ).resolves.toBeNull();
  });
});
