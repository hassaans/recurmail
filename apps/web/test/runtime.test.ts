import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCookie } from "../lib/auth-flow";
import type { StoredConnection } from "../lib/connections";
import { decryptRefreshToken } from "../lib/crypto";
import { configuredRuntime, createRuntime, runRoute } from "../lib/runtime";

const config = {
  origin: "https://app.test",
  key: randomBytes(32).toString("base64"),
  supabaseUrl: "https://db.test",
  publishableKey: "fake-publishable",
  secretKey: "fake-secret",
  googleClientId: "fake-id",
  googleClientSecret: "fake-secret",
};
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const request = (cookie?: string) =>
  new Request(`${config.origin}/dashboard`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
const cookie = (expiresAt = Date.now() + 3600000) =>
  sessionCookie(
    {
      accessToken: "fake-access",
      refreshToken: "fake-session-refresh",
      expiresAt,
    },
    config.key,
    config.origin,
  ).split(";")[0];

describe("dashboard runtime uses validated identity and safe persistence", () => {
  it("wires test-only loopback OAuth injection without changing session verification", async () => {
    setEnvironment();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RECURMAIL_TEST_OAUTH_ORIGIN", "http://127.0.0.1:3101");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "owner", email: "owner@gmail.com" }),
        ),
    );
    try {
      const response = await runRoute(
        "connect",
        new Request(`${config.origin}/api/gmail/connect`, {
          method: "POST",
          headers: { Origin: config.origin, Cookie: cookie() },
        }),
      );
      expect(new URL(response.headers.get("location") ?? "").origin).toBe(
        "http://127.0.0.1:3101",
      );
      const unsigned = await runRoute(
        "connect",
        new Request(`${config.origin}/api/gmail/connect`, {
          method: "POST",
          headers: { Origin: config.origin },
        }),
      );
      expect(unsigned.headers.get("location")).toBe(
        `${config.origin}/dashboard?auth=required`,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it.each(["identity", "storage", "configuration"])(
    "logs %s errors without credentials, emails or unverified user IDs",
    async (operation) => {
      const secret =
        "fake-secret access-token refresh-token oauth-code owner@gmail.com provider-body unverified-user";
      if (operation === "configuration") {
        setEnvironment();
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", secret);
        try {
          expect(configuredRuntime()).toBeNull();
        } finally {
          vi.unstubAllEnvs();
        }
      } else {
        const fetcher = vi.fn();
        if (operation === "storage")
          fetcher.mockResolvedValueOnce(
            Response.json({ id: "owner", email: "owner@gmail.com" }),
          );
        fetcher.mockRejectedValue(new Error(secret));
        expect(
          await createRuntime({ ...config, fetcher }).dashboard(
            request(cookie()),
          ),
        ).toEqual({ kind: "unavailable" });
      }
      expect(console.error).toHaveBeenCalledWith(
        `[ERROR] runtime_${operation === "configuration" ? "configuration" : "dashboard"}_failed`,
      );
      const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of secret.split(" ")) expect(logs).not.toContain(value);
    },
  );
  it("renders sign-in state with no session without a database call", async () => {
    const fetcher = vi.fn();
    const runtime = createRuntime({ ...config, fetcher });
    expect(await runtime.dashboard(request())).toEqual({ kind: "signed_out" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("renders the Connect Gmail state for an authenticated user without a connection", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "owner", email: "owner@gmail.com" }),
      )
      .mockResolvedValueOnce(Response.json([]));
    const runtime = createRuntime({ ...config, fetcher });
    expect(await runtime.dashboard(request(cookie()))).toEqual({
      kind: "signed_in",
      user: { id: "owner", email: "owner@gmail.com" },
      connection: null,
    });
    expect(
      new URL(fetcher.mock.calls[1][0]).searchParams.get("select"),
    ).not.toContain("encrypted_refresh_token");
  });
  it("does not pass any credential to the connected dashboard", async () => {
    const row = {
      user_id: "owner",
      google_email: "owner@gmail.com",
      is_workspace: false,
      status: "connected",
      connected_at: "2026-10-14",
      encrypted_refresh_token: "v1.secret",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "owner", email: "owner@gmail.com" }),
      )
      .mockResolvedValueOnce(Response.json([row]));
    const state = await createRuntime({ ...config, fetcher }).dashboard(
      request(cookie()),
    );
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(JSON.stringify(state)).not.toContain("fake-access");
    expect(state).toMatchObject({
      kind: "signed_in",
      connection: { status: "connected" },
    });
  });
  it("refreshes expired sessions through a route that can set HttpOnly cookies", async () => {
    const fetcher = vi.fn();
    expect(
      await createRuntime({ ...config, fetcher }).dashboard(request(cookie(0))),
    ).toEqual({ kind: "refresh" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unverified identity and handles storage outages without exposing diagnostics", async () => {
    const denied = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    expect(
      await createRuntime({ ...config, fetcher: denied }).dashboard(
        request(cookie()),
      ),
    ).toEqual({ kind: "signed_out" });
    const failed = vi.fn().mockRejectedValue(new Error("fake-secret"));
    expect(
      await createRuntime({ ...config, fetcher: failed }).dashboard(
        request(cookie()),
      ),
    ).toEqual({ kind: "unavailable" });
  });
  it("returns a setup response when environment is absent, and does not infer origin from request headers", async () => {
    vi.stubEnv("APP_URL", "");
    try {
      expect(configuredRuntime()).toBeNull();
      const response = await runRoute(
        "connect",
        new Request("https://attacker.test/api/gmail/connect", {
          method: "POST",
        }),
      );
      expect(response.headers.get("location")).toBe(
        "/dashboard?auth=unavailable",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs sign-in, encrypted Gmail connection and disconnect through the native HTTP adapters", async () => {
    let row: StoredConnection | null = null;
    const schedules = [
      { user_id: "owner", status: "active" },
      { user_id: "other", status: "active" },
    ];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/user")
          return Response.json({ id: "owner", email: "owner@gmail.com" });
        if (url.pathname === "/auth/v1/token")
          return Response.json({
            access_token: "fake-access",
            refresh_token: "fake-session-refresh",
            expires_in: 3600,
            provider_token: "fake-google-access",
            provider_refresh_token: "fake-google-refresh",
          });
        if (
          url.origin === "https://oauth2.googleapis.com" &&
          url.pathname === "/token"
        )
          return Response.json({
            refresh_token: "fake-gmail-refresh",
            scope: "https://www.googleapis.com/auth/gmail.send",
          });
        if (
          url.origin === "https://oauth2.googleapis.com" &&
          url.pathname === "/revoke"
        ) {
          expect(new URLSearchParams(String(init?.body)).get("token")).toBe(
            "fake-gmail-refresh",
          );
          return new Response(null, { status: 200 });
        }
        expect(new Headers(init?.headers).get("apikey")).toBe("fake-secret");
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        if (url.pathname === "/rest/v1/gmail_connections") {
          if (init?.method === "POST") {
            row = JSON.parse(String(init.body));
            expect(row).toMatchObject({
              user_id: "owner",
              google_email: "owner@gmail.com",
              status: "connected",
            });
            return new Response(null, { status: 204 });
          }
          expect(url.searchParams.get("user_id")).toBe("eq.owner");
          if (init?.method === "DELETE") {
            row = null;
            return new Response(null, { status: 204 });
          }
          expect(url.searchParams.get("select")).toBe(
            "encrypted_refresh_token",
          );
          return Response.json(
            row
              ? [{ encrypted_refresh_token: row.encrypted_refresh_token }]
              : [],
          );
        }
        if (url.pathname === "/rest/v1/schedules") {
          expect(url.searchParams.get("user_id")).toBe("eq.owner");
          expect(JSON.parse(String(init?.body))).toMatchObject({
            status: "paused",
          });
          for (const schedule of schedules)
            if (schedule.user_id === "owner") schedule.status = "paused";
          return new Response(null, { status: 204 });
        }
        throw new Error("Unexpected fake HTTP request");
      },
    );
    setEnvironment();
    vi.stubGlobal("fetch", fetcher);
    try {
      const signin = await runRoute("signin", request());
      const authRedirect = new URL(
        new URL(signin.headers.get("location") ?? "").searchParams.get(
          "redirect_to",
        ) ?? "",
      );
      authRedirect.searchParams.set("code", "fake-auth-code");
      const signedIn = await runRoute(
        "authCallback",
        new Request(authRedirect, {
          headers: {
            Cookie: signin.headers.get("set-cookie")?.split(";")[0] ?? "",
          },
        }),
      );
      expect(signedIn.headers.get("location")).toBe(
        `${config.origin}/dashboard`,
      );
      const session =
        signedIn.headers
          .getSetCookie()
          .find((value) => value.startsWith("rm_session="))
          ?.split(";")[0] ?? "";
      const post = (path: string) =>
        new Request(`${config.origin}${path}`, {
          method: "POST",
          headers: { Origin: config.origin, Cookie: session },
        });
      const connect = await runRoute("connect", post("/api/gmail/connect"));
      const googleUrl = new URL(connect.headers.get("location") ?? "");
      const callback = new URL(
        googleUrl.searchParams.get("redirect_uri") ?? "",
      );
      callback.searchParams.set(
        "state",
        googleUrl.searchParams.get("state") ?? "",
      );
      callback.searchParams.set("code", "fake-gmail-code");
      const connected = await runRoute(
        "callback",
        new Request(callback, {
          headers: {
            Cookie: `${session}; ${connect.headers.get("set-cookie")?.split(";")[0]}`,
          },
        }),
      );
      expect(connected.headers.get("location")).toBe(
        `${config.origin}/dashboard?gmail=connected`,
      );
      const stored = row as StoredConnection | null;
      expect(
        decryptRefreshToken(
          stored?.encrypted_refresh_token ?? "",
          config.key,
          "owner",
        ),
      ).toBe("fake-gmail-refresh");
      expect(JSON.stringify(stored)).not.toContain("fake-gmail-refresh");
      const refreshed = await runRoute("refresh", request(session));
      expect(refreshed.headers.get("location")).toBe(
        `${config.origin}/dashboard`,
      );
      const disconnected = await runRoute(
        "disconnect",
        post("/api/gmail/disconnect"),
      );
      expect(disconnected.headers.get("location")).toBe(
        `${config.origin}/dashboard?gmail=disconnected`,
      );
      expect(row).toBeNull();
      expect(schedules).toEqual([
        { user_id: "owner", status: "paused" },
        { user_id: "other", status: "active" },
      ]);
      const unsigned = await runRoute(
        "connect",
        new Request(`${config.origin}/api/gmail/connect`, {
          method: "POST",
          headers: { Origin: config.origin },
        }),
      );
      expect(unsigned.headers.get("location")).toBe(
        `${config.origin}/dashboard?auth=required`,
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "TOKEN_ENCRYPTION_KEY",
  ])("fails closed without %s", (variable) => {
    setEnvironment();
    vi.stubEnv(variable, "");
    try {
      expect(configuredRuntime()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["http://attacker.test", "ftp://app.test", "bad-url"])(
    "rejects unsafe or malformed app origin %s",
    (url) => {
      setEnvironment();
      vi.stubEnv("APP_URL", url);
      try {
        expect(configuredRuntime()).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("allows local HTTP development without Secure cookies", async () => {
    setEnvironment();
    vi.stubEnv("APP_URL", "http://localhost:3000");
    try {
      const response = await runRoute(
        "signin",
        new Request("http://localhost:3000/auth/signin"),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).not.toContain("Secure");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function setEnvironment() {
  const env = {
    APP_URL: config.origin,
    NEXT_PUBLIC_SUPABASE_URL: config.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    SUPABASE_SECRET_KEY: config.secretKey,
    GOOGLE_CLIENT_ID: config.googleClientId,
    GOOGLE_CLIENT_SECRET: config.googleClientSecret,
    TOKEN_ENCRYPTION_KEY: config.key,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}
