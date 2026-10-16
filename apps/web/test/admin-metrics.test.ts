import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAcquisition,
  loadAdminMetrics,
  validSummary,
} from "../lib/admin-metrics";
import { sessionCookie } from "../lib/auth-flow";

const metrics = {
  signed_up_users: 12,
  connected_gmail_accounts: 8,
  active_schedules: 17,
  sends_last_24_hours: 90,
  kept_sending_30_days: 3,
  failed_last_hour: 2,
  attempted_last_hour: 20,
  failure_rate_last_hour: 0.1,
};
const env = {
  ADMIN_EMAILS: "owner@example.com",
  TOKEN_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(1)).toString(
    "base64",
  ),
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_PUBLISHABLE_KEY: "publishable",
  SUPABASE_SECRET_KEY: "sb_secret_admin",
};

function ownerRequest() {
  const request = new Request("https://recurmail.com/admin");
  request.headers.set(
    "cookie",
    sessionCookie(
      {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 60_000,
      },
      env.TOKEN_ENCRYPTION_KEY,
      "https://recurmail.com",
    ).split(";")[0],
  );
  return request;
}

describe("owner admin metrics", () => {
  it("returns 404-equivalent null for a non-owner before querying metrics", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input));
      return Response.json({ id: "user", email: "other@example.com" });
    };
    const result = await loadAdminMetrics(ownerRequest(), env, fetcher);
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns aggregate counts only to an owner", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/auth/v1/user"))
        return Response.json({ id: "owner", email: "OWNER@example.com" });
      return Response.json(metrics);
    };
    const result = await loadAdminMetrics(ownerRequest(), env, fetcher);
    expect(result).toEqual(metrics);
    expect(calls[1].url).toContain("/rpc/get_admin_metrics");
    expect(calls[0].init?.headers).toEqual({
      apikey: "publishable",
      Authorization: "Bearer access",
    });
    expect(calls[1].init?.headers).toEqual({
      apikey: "sb_secret_admin",
      "content-type": "application/json",
    });
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
  });
});

describe("owner acquisition summary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const summary = {
    days: 7,
    visitors: 40,
    signups: 4,
    funnel: {
      page_view: 40,
      signup_started: 10,
      signup_completed: 4,
      gmail_connected: 3,
      schedule_created: 2,
    },
    sources: [{ source: "reddit", visitors: 25, signups: 3 }],
    landing_paths: [{ path: "/", visitors: 30 }],
    referrers: [{ host: "reddit.com", visitors: 25 }],
    events: [{ event: "page_view", count: 90 }],
  };

  it("asks the database for each window with the secret key only", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      const days = JSON.parse(String(init?.body)).p_days;
      return Response.json({ ...summary, days });
    };
    const result = await loadAcquisition([7, 30], env, fetcher);
    expect(result?.map((window) => window.days)).toEqual([7, 30]);
    expect(result?.[0]).toEqual(summary);
    expect(calls.map((call) => call.url)).toEqual([
      "https://db.example.test/rest/v1/rpc/get_analytics_summary",
      "https://db.example.test/rest/v1/rpc/get_analytics_summary",
    ]);
    expect(calls[0].init?.headers).toEqual({
      apikey: "sb_secret_admin",
      "Content-Type": "application/json",
    });
  });

  it("returns null when the summary is unavailable, so the page still renders", async () => {
    const fetcher: typeof fetch = async () =>
      new Response("down", { status: 500 });
    expect(await loadAcquisition([7], env, fetcher)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] admin_acquisition_failed",
    );
    expect(
      await loadAcquisition([7], { ...env, SUPABASE_SECRET_KEY: "" }, fetcher),
    ).toBeNull();
  });

  it("fills in every section whatever shape comes back", () => {
    expect(validSummary(null, 30)).toEqual({
      days: 30,
      visitors: 0,
      signups: 0,
      funnel: {
        page_view: 0,
        signup_started: 0,
        signup_completed: 0,
        gmail_connected: 0,
        schedule_created: 0,
      },
      sources: [],
      landing_paths: [],
      referrers: [],
      events: [],
    });
    expect(
      validSummary(
        {
          visitors: "many",
          funnel: { page_view: 3 },
          sources: [{ source: "reddit", visitors: 2 }, { visitors: 1 }, null],
          landing_paths: "none",
        },
        7,
      ),
    ).toMatchObject({
      visitors: 0,
      funnel: { page_view: 3, signup_started: 0 },
      sources: [{ source: "reddit", visitors: 2, signups: 0 }],
      landing_paths: [],
    });
  });
});
