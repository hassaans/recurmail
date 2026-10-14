import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCookie } from "../lib/auth-flow";
import { encryptRefreshToken } from "../lib/crypto";
import { createRuntime } from "../lib/runtime";

const config = {
  origin: "https://app.test",
  key: randomBytes(32).toString("base64"),
  supabaseUrl: "https://db.test",
  anonKey: "fake-anon",
  serviceKey: "fake-service",
  googleClientId: "fake-id",
  googleClientSecret: "fake-secret",
};
const user = { id: "owner", email: "owner@gmail.com" };
const googleToken = "google-refresh-secret";
const session = sessionCookie(
  {
    accessToken: "session-access",
    refreshToken: "session-refresh",
    expiresAt: Date.now() + 3600000,
  },
  config.key,
  config.origin,
);
const accountRequest = (confirmation = "delete", origin = config.origin) =>
  new Request(config.origin + "/api/account", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: session.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ confirmation }),
  });

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("account deletion", () => {
  it("revokes the decrypted Google token, deletes the auth user, and clears the session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/auth/v1/user")) return Response.json(user);
        if (url.includes("/rest/v1/gmail_connections"))
          return Response.json([
            {
              encrypted_refresh_token: encryptRefreshToken(
                googleToken,
                config.key,
                user.id,
              ),
            },
          ]);
        if (url === "https://oauth2.googleapis.com/revoke")
          return Response.json({});
        if (url === "https://db.test/auth/v1/admin/users/owner")
          return Response.json({ id: user.id });
        throw new Error("Unexpected request: " + url);
      },
    );
    const runtime = createRuntime({ ...config, fetcher });

    const response = await runtime.account(accountRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      config.origin + "/?account=deleted",
    );
    expect(response.headers.get("set-cookie")).toContain("rm_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(calls.map(({ url }) => url)).toEqual([
      "https://db.test/auth/v1/user",
      "https://db.test/rest/v1/gmail_connections?user_id=eq.owner&select=encrypted_refresh_token",
      "https://oauth2.googleapis.com/revoke",
      "https://db.test/auth/v1/admin/users/owner",
    ]);
    expect(String(calls[2].init?.body)).toContain(googleToken);
    expect(calls[3].init?.method).toBe("DELETE");
    expect(calls[3].init?.headers).toMatchObject({
      Authorization: "Bearer fake-service",
    });
  });

  it("deletes the user even when Google token revocation fails and logs no token", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return Response.json(user);
      if (url.includes("/rest/v1/gmail_connections"))
        return Response.json([
          {
            encrypted_refresh_token: encryptRefreshToken(
              googleToken,
              config.key,
              user.id,
            ),
          },
        ]);
      if (url === "https://oauth2.googleapis.com/revoke")
        return new Response(null, { status: 503 });
      if (url.endsWith("/auth/v1/admin/users/owner"))
        return Response.json({ id: user.id });
      throw new Error("Unexpected request: " + url);
    });
    const response = await createRuntime({ ...config, fetcher }).account(
      accountRequest(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      config.origin + "/?account=deleted",
    );
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).endsWith("/auth/v1/admin/users/owner"),
      ),
    ).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] account_google_revocation_failed",
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      googleToken,
    );
  });

  it("requires same-origin POST and an explicit delete confirmation before any request", async () => {
    const fetcher = vi.fn();
    const runtime = createRuntime({ ...config, fetcher });
    const crossOrigin = await runtime.account(
      accountRequest("delete", "https://attacker.test"),
    );
    const notConfirmed = await runtime.account(accountRequest("DELETE"));
    const get = await runtime.account(
      new Request(config.origin + "/api/account", { method: "GET" }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(notConfirmed.status).toBe(400);
    expect(get.status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
