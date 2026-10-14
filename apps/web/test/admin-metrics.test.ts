import { describe, expect, it } from "vitest";
import { loadAdminMetrics } from "../lib/admin-metrics";
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
  NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
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
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
  });
});
