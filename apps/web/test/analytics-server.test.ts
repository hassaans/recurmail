import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsEventRow } from "../lib/analytics-events";
import {
  createServerAnalytics,
  requestDetails,
  tokenIdentity,
} from "../lib/analytics-server";
import { encodeFirstTouchCookie } from "../lib/analytics-source";
import {
  type AnalyticsStore,
  type AttributionRow,
  createAnalyticsStore,
} from "../lib/analytics-store";
import { createAuthHandlers, sessionCookie } from "../lib/auth-flow";
import { describeSchedule } from "../lib/schedules";

const origin = "https://app.test";
const key = randomBytes(32).toString("base64");
const userId = "00000000-0000-4000-8000-000000000051";
const user = { id: userId, email: "owner@gmail.com" };
const browser =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const anonymousId = "a0000000-0000-4000-8000-000000000001";
const sessionId = "b0000000-0000-4000-8000-000000000001";
const firstTouch = {
  utm_source: "reddit",
  utm_medium: "social",
  source: "reddit",
  referrer_host: "reddit.com",
  landing_path: "/",
  first_seen_at: "2026-10-16T08:00:00.000Z",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function store() {
  return {
    insertEvent: vi.fn(async (_row: AnalyticsEventRow) => {}),
    recordClientEvent: vi.fn(async () => true),
    hasAttribution: vi.fn(async () => false),
    insertAttribution: vi.fn(async (_row: AttributionRow) => {}),
    summary: vi.fn(async () => ({})),
  } satisfies AnalyticsStore;
}

function request(cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/schedules`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "User-Agent": browser,
      "Accept-Language": "en-GB,en;q=0.9",
      ...headers,
    },
  });
}

const browserCookies = `rm_aid=${anonymousId}; rm_sid=${sessionId}; rm_ft=${encodeFirstTouchCookie(firstTouch)}`;

describe("server-side tracking", () => {
  it("records an event with the browser's cookies, the page it came from, the user and the request details", async () => {
    const s = store();
    const analytics = createServerAnalytics({ origin, store: s });
    await analytics.track(
      request(browserCookies, {
        Referer: `${origin}/schedules/new?draft=1`,
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "x-vercel-ip-country": "DE",
        "x-vercel-ip-country-region": "BE",
        "x-vercel-ip-city": "Berlin%20Mitte",
      }),
      "schedule_created",
      { userId, userEmail: user.email, properties: { frequency: "weekly" } },
    );
    expect(s.insertEvent).toHaveBeenCalledWith({
      event: "schedule_created",
      anonymous_id: anonymousId,
      session_id: sessionId,
      user_id: userId,
      user_email: "owner@gmail.com",
      path: "/schedules/new",
      referrer_host: null,
      source: null,
      device: null,
      ip_address: "203.0.113.9",
      user_agent: browser,
      accept_language: "en-GB,en;q=0.9",
      country: "DE",
      region: "BE",
      city: "Berlin Mitte",
      is_bot: false,
      properties: { frequency: "weekly" },
    });
  });

  it("reads the request details defensively", () => {
    const details = (headers: Record<string, string>) =>
      requestDetails(new Request(origin, { headers }));
    expect(details({ "x-real-ip": "2001:db8::1" })).toMatchObject({
      ip_address: "2001:db8::1",
      user_agent: null,
      accept_language: null,
      country: null,
      region: null,
      city: null,
      is_bot: true,
    });
    expect(details({ "x-forwarded-for": "[2001:db8::2]" }).ip_address).toBe(
      "2001:db8::2",
    );
    expect(details({ "x-forwarded-for": "unknown" }).ip_address).toBeNull();
    expect(
      details({ "x-forwarded-for": "203.0.113.9:443" }).ip_address,
    ).toBeNull();
    expect(details({ "x-vercel-ip-city": "%E4" }).city).toBe("%E4");
    expect(details({ "user-agent": "curl/8.4.0" }).is_bot).toBe(true);
    expect(details({ "user-agent": "x".repeat(2000) }).user_agent).toHaveLength(
      1024,
    );
    expect(
      details({ "accept-language": "a".repeat(300) }).accept_language,
    ).toHaveLength(255);
  });

  it("ignores forged cookie ids and foreign referers", async () => {
    const s = store();
    const analytics = createServerAnalytics({ origin, store: s });
    await analytics.track(
      request("rm_aid=not-a-uuid; rm_sid=' or 1=1", {
        Referer: "https://attacker.test/schedules/new",
      }),
      "signed_out",
    );
    expect(s.insertEvent.mock.calls[0][0]).toMatchObject({
      anonymous_id: null,
      session_id: null,
      user_id: null,
      user_email: null,
      path: null,
      properties: {},
    });
  });

  it("never throws when storage fails", async () => {
    const s = store();
    s.insertEvent.mockRejectedValue(new Error("fake-secret upstream"));
    const analytics = createServerAnalytics({ origin, store: s });
    await expect(
      analytics.track(request(browserCookies), "signed_out"),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] analytics_track_failed",
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "fake-secret",
    );
  });

  it("writes attribution from the first-touch cookie for a user without one", async () => {
    const s = store();
    const analytics = createServerAnalytics({
      origin,
      store: s,
      now: () => Date.parse("2026-10-16T09:00:00.000Z"),
    });
    await expect(
      analytics.recordSignup(
        request(browserCookies, { "x-forwarded-for": "203.0.113.9" }),
        user,
      ),
    ).resolves.toBe(true);
    expect(s.hasAttribution).toHaveBeenCalledWith(userId);
    expect(s.insertAttribution).toHaveBeenCalledWith({
      user_id: userId,
      anonymous_id: anonymousId,
      user_email: "owner@gmail.com",
      signup_ip: "203.0.113.9",
      signup_user_agent: browser,
      first_source: "reddit",
      first_referrer_host: "reddit.com",
      first_utm_source: "reddit",
      first_utm_medium: "social",
      first_utm_campaign: null,
      first_utm_term: null,
      first_utm_content: null,
      first_landing_path: "/",
      first_seen_at: "2026-10-16T08:00:00.000Z",
      signed_up_at: "2026-10-16T09:00:00.000Z",
    });
  });

  it("falls back to direct without cookies, skips users who have a row, and swallows failures", async () => {
    const s = store();
    const analytics = createServerAnalytics({ origin, store: s });
    await expect(
      analytics.recordSignup(
        request("rm_ft=tampered!!"),
        user,
        "2025-01-01T00:00:00.000Z",
      ),
    ).resolves.toBe(true);
    expect(s.insertAttribution.mock.calls[0][0]).toMatchObject({
      anonymous_id: null,
      first_source: "direct",
      first_landing_path: null,
      signup_ip: null,
      signed_up_at: "2025-01-01T00:00:00.000Z",
    });
    s.hasAttribution.mockResolvedValueOnce(true);
    await expect(
      analytics.recordSignup(request(browserCookies), user),
    ).resolves.toBe(false);
    expect(s.insertAttribution).toHaveBeenCalledTimes(1);
    s.hasAttribution.mockRejectedValueOnce(new Error("down"));
    await expect(
      analytics.recordSignup(request(browserCookies), user),
    ).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] analytics_attribution_failed",
    );
  });

  it("reads the user out of a Supabase access token and nothing else", () => {
    const token = (claims: object) =>
      `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    expect(tokenIdentity(token({ sub: userId, email: "x@y.z" }))).toEqual({
      id: userId,
      email: "x@y.z",
    });
    expect(tokenIdentity(token({ sub: userId }))).toEqual({
      id: userId,
      email: null,
    });
    expect(tokenIdentity(token({ sub: "owner" }))).toBeNull();
    expect(tokenIdentity("fake-secret-session-access-123")).toBeNull();
    expect(tokenIdentity("a.b")).toBeNull();
    expect(tokenIdentity("a.!!!.c")).toBeNull();
    expect(tokenIdentity(undefined)).toBeNull();
  });

  it("describes a schedule without its recipients or content", () => {
    expect(
      describeSchedule({
        rrule: "DTSTART:20261019T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO",
        to: ["a@example.test", "b@example.test"],
        cc: ["c@example.test"],
        bcc: [],
        body_html: "<p>Hi</p>",
      }),
    ).toEqual({ frequency: "weekly", recipients: "2-5", html: true });
    expect(
      describeSchedule({
        rrule: "FREQ=MONTHLY",
        to: ["a@example.test"],
        cc: [],
        bcc: [],
        body_html: null,
      }),
    ).toEqual({ frequency: "monthly", recipients: "1", html: false });
    expect(
      describeSchedule({
        rrule: "nonsense",
        to: Array(30).fill("a@example.test"),
        cc: [],
        bcc: [],
        body_html: null,
      }),
    ).toEqual({ frequency: "unknown", recipients: "21+", html: false });
  });
});

describe("sign-up and sign-in events", () => {
  function fixture(user: { id: string; email: string; createdAt?: string }) {
    const google = {
      authorizationUrl: vi.fn(
        ({ state }: { state: string }) =>
          `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      ),
      exchangeCode: vi.fn(async () => "fake-google-id-token"),
    };
    const auth = {
      exchangeIdToken: vi.fn(async () => ({
        accessToken: "fake-access",
        refreshToken: "fake-session-refresh",
        expiresAt: 10000,
      })),
      refresh: vi.fn(async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: 10000,
      })),
      getUser: vi.fn(async () => user),
    };
    const analytics = {
      track: vi.fn(async () => {}),
      recordSignup: vi.fn(async () => true),
    };
    const now = () => Date.parse("2026-10-16T09:00:00.000Z");
    const handlers = createAuthHandlers({
      origin,
      key,
      auth,
      google,
      analytics,
      now,
    });
    const callback = async () => {
      const start = await handlers.signin();
      const state = new URL(
        start.headers.get("location") ?? origin,
      ).searchParams.get("state");
      const cookie = start.headers.get("set-cookie")?.split(";")[0] ?? "";
      return handlers.callback(
        new Request(`${origin}/auth/callback?state=${state}&code=code`, {
          headers: { Cookie: `${cookie}; ${browserCookies}` },
        }),
      );
    };
    return { analytics, handlers, callback };
  }

  it("records a sign-up for a user Supabase just created who has no attribution yet", async () => {
    const f = fixture({
      id: userId,
      email: "owner@gmail.com",
      createdAt: "2026-10-16T08:59:30.000Z",
    });
    const response = await f.callback();
    expect(response.headers.get("location")).toBe(`${origin}/dashboard`);
    expect(f.analytics.recordSignup).toHaveBeenCalledWith(
      expect.any(Request),
      {
        id: userId,
        email: "owner@gmail.com",
        createdAt: "2026-10-16T08:59:30.000Z",
      },
      "2026-10-16T08:59:30.000Z",
    );
    expect(f.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "signup_completed",
      { userId, userEmail: "owner@gmail.com" },
    );
  });

  it("treats a user with no creation time as new when they have no attribution row", async () => {
    const f = fixture({ id: userId, email: "owner@gmail.com" });
    await f.callback();
    expect(f.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "signup_completed",
      { userId, userEmail: "owner@gmail.com" },
    );
  });

  it("records a sign-in for a user who already has attribution, or whose account is older", async () => {
    const returning = fixture({
      id: userId,
      email: "owner@gmail.com",
      createdAt: "2026-10-16T08:59:30.000Z",
    });
    returning.analytics.recordSignup.mockResolvedValue(false);
    await returning.callback();
    expect(returning.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "login_completed",
      { userId, userEmail: "owner@gmail.com" },
    );
    // An account from before analytics existed gets its row now, but no sign-up event.
    const legacy = fixture({
      id: userId,
      email: "owner@gmail.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await legacy.callback();
    expect(legacy.analytics.recordSignup).toHaveBeenCalledWith(
      expect.any(Request),
      {
        id: userId,
        email: "owner@gmail.com",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "2026-01-01T00:00:00.000Z",
    );
    expect(legacy.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "login_completed",
      { userId, userEmail: "owner@gmail.com" },
    );
  });

  it("records sign-out with the user from the sealed session", async () => {
    const f = fixture({ id: userId, email: "owner@gmail.com" });
    const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: userId, email: "owner@gmail.com" })).toString("base64url")}.sig`;
    const cookie = sessionCookie(
      { accessToken: token, refreshToken: "r", expiresAt: 10000 },
      key,
      origin,
    ).split(";")[0];
    const response = await f.handlers.signout(
      new Request(`${origin}/auth/signout`, {
        method: "POST",
        headers: { Cookie: `${cookie}; ${browserCookies}`, Origin: origin },
      }),
    );
    expect(response.status).toBe(303);
    expect(f.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "signed_out",
      { userId, userEmail: "owner@gmail.com" },
    );
  });
});

describe("analytics store", () => {
  function storeWith(reply: unknown, status = 200) {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(reply), { status }),
    );
    return {
      fetcher,
      store: createAnalyticsStore({
        url: "https://db.test",
        secretKey: "sb_secret_test",
        fetcher,
      }),
    };
  }
  const row = {
    event: "page_view",
    anonymous_id: anonymousId,
    session_id: sessionId,
    user_id: null,
    user_email: null,
    path: "/",
    referrer_host: null,
    source: "direct",
    device: "desktop",
    ip_address: "198.51.100.7",
    user_agent: browser,
    accept_language: null,
    country: null,
    region: null,
    city: null,
    is_bot: false,
    properties: {},
  } satisfies AnalyticsEventRow;
  const budget = { windowSeconds: 3600, maxEvents: 600, maxBrowsers: 30 };

  it("records a browser event through record_client_event with its budget", async () => {
    const f = storeWith(true);
    await expect(f.store.recordClientEvent(row, budget)).resolves.toBe(true);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(String(url)).toBe("https://db.test/rest/v1/rpc/record_client_event");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      p_event: row,
      p_window_seconds: 3600,
      p_max_events: 600,
      p_max_browsers: 30,
    });
  });

  it("reports a refused event and rejects anything but a boolean", async () => {
    await expect(
      storeWith(false).store.recordClientEvent(row, budget),
    ).resolves.toBe(false);
    await expect(
      storeWith({ stored: true }).store.recordClientEvent(row, budget),
    ).rejects.toThrow("record_client_event");
    await expect(
      storeWith({}, 500).store.recordClientEvent(row, budget),
    ).rejects.toThrow("record_client_event");
  });
});
