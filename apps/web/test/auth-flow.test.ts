import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthHandlers,
  readSession,
  sessionCookie,
} from "../lib/auth-flow";
import { decryptRefreshToken, encryptRefreshToken } from "../lib/crypto";
import { createSupabaseAuth } from "../lib/supabase-auth";

const key = randomBytes(32).toString("base64");
const origin = "https://app.test";
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const request = (path: string, cookie?: string) =>
  new Request(`${origin}${path}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
function fixture() {
  const auth = {
    ...createSupabaseAuth({
      url: "https://db.test",
      publishableKey: "fake-publishable",
    }),
    exchangeCode: vi.fn(async () => ({
      accessToken: "fake-access",
      refreshToken: "fake-session-refresh",
      expiresAt: 10000,
    })),
    getUser: vi.fn(async () => ({ id: "owner", email: "owner@gmail.com" })),
    refresh: vi.fn(async () => ({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 10000,
    })),
  };
  const now = vi.fn(() => 1000);
  const handlers = createAuthHandlers({ origin, key, auth, now });
  const start = async () => {
    const response = await handlers.signin();
    const url = new URL(response.headers.get("location") ?? origin);
    const state = new URL(
      url.searchParams.get("redirect_to") ?? origin,
    ).searchParams.get("state");
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { response, url, state, cookie };
  };
  return { auth, now, handlers, start };
}

describe("server Supabase sign-in HTTP flow", () => {
  it.each(["signin", "callback", "refresh", "session"])(
    "logs %s errors at ERROR level without credentials or provider diagnostics",
    async (operation) => {
      const f = fixture();
      const secret =
        "fake-secret access-token refresh-token oauth-code owner@gmail.com provider-body";
      let result: Response | null = null;
      if (operation === "signin") {
        f.auth.authorizationUrl = () => {
          throw new Error(secret);
        };
        result = await f.handlers.signin();
      } else if (operation === "callback") {
        const { cookie, state } = await f.start();
        f.auth.exchangeCode.mockRejectedValue(new Error(secret));
        result = await f.handlers.callback(
          request(`/auth/callback?state=${state}&code=oauth-code`, cookie),
        );
      } else if (operation === "refresh") {
        f.auth.refresh.mockRejectedValue(new Error(secret));
        const cookie = sessionCookie(
          {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: 0,
          },
          key,
          origin,
        ).split(";")[0];
        result = await f.handlers.refresh(request("/auth/refresh", cookie));
      } else {
        expect(
          readSession(request("/dashboard", `rm_session=${secret}`), key),
        ).toBeNull();
      }
      expect(console.error).toHaveBeenCalledWith(
        `[ERROR] auth_${operation}_failed`,
      );
      const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of secret.split(" ")) expect(logs).not.toContain(value);
      if (result) {
        expect(result.headers.get("location")).toBe(
          `${origin}/dashboard?auth=failed`,
        );
        expect(await result.text()).not.toContain("fake-secret");
      }
    },
  );
  it("uses a fresh state and S256 PKCE and keeps only Supabase tokens in an HttpOnly session", async () => {
    const f = fixture();
    const { response, url, state, cookie } = await f.start();
    const saved = JSON.parse(
      decryptRefreshToken(cookie.split("=")[1], key, "auth-state"),
    );
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(saved.verifier).digest("base64url"),
    );
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const second = await f.start();
    expect(second.state).not.toBe(state);
    const result = await f.handlers.callback(
      request(`/auth/callback?state=${state}&code=code`, cookie),
    );
    expect(result.headers.get("location")).toBe(`${origin}/dashboard`);
    expect(f.auth.exchangeCode).toHaveBeenCalledWith("code", saved.verifier);
    const sessionHeader =
      result.headers
        .getSetCookie()
        .find((value) => value.startsWith("rm_session=")) ?? "";
    expect(sessionHeader).toMatch(/Secure/);
    expect(sessionHeader).toMatch(/HttpOnly/);
    expect(sessionHeader).not.toContain("fake-access");
    expect(
      readSession(request("/dashboard", sessionHeader.split(";")[0]), key),
    ).toEqual({
      accessToken: "fake-access",
      refreshToken: "fake-session-refresh",
      expiresAt: 10000,
    });
    expect(await result.text()).toBe("");
  });

  it.each(["missing", "mismatch", "expired", "tampered", "denied", "no-code"])(
    "rejects %s sign-in callback safely",
    async (kind) => {
      const f = fixture();
      let { cookie, state } = await f.start();
      if (kind === "missing") cookie = "";
      if (kind === "mismatch") state = "forged";
      if (kind === "expired") f.now.mockReturnValue(700000);
      if (kind === "tampered") cookie = "rm_auth_state=v1.bad.tag.data";
      const params =
        kind === "denied"
          ? "error=access_denied&error_description=secret"
          : kind === "no-code"
            ? ""
            : "code=code";
      const result = await f.handlers.callback(
        request(`/auth/callback?state=${state}&${params}`, cookie),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?auth=failed`,
      );
      expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(f.auth.exchangeCode).not.toHaveBeenCalled();
    },
  );

  it.each(["exchange", "identity"])(
    "does not create a session on %s failure",
    async (kind) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      if (kind === "exchange")
        f.auth.exchangeCode.mockRejectedValue(new Error("fake-secret"));
      else f.auth.getUser.mockResolvedValue(null as never);
      const result = await f.handlers.callback(
        request(`/auth/callback?state=${state}&code=code`, cookie),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?auth=failed`,
      );
      expect(
        result.headers
          .getSetCookie()
          .some((value) => value.startsWith("rm_session=")),
      ).toBe(false);
    },
  );

  it("refreshes a server session and clears it when the refresh is rejected", async () => {
    const f = fixture();
    const cookie = sessionCookie(
      {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1000,
      },
      key,
      origin,
    ).split(";")[0];
    const refreshed = await f.handlers.refresh(
      request("/auth/refresh", cookie),
    );
    expect(refreshed.headers.get("location")).toBe(`${origin}/dashboard`);
    expect(f.auth.refresh).toHaveBeenCalledWith("old-refresh");
    f.auth.refresh.mockRejectedValue(new Error("secret"));
    const failed = await f.handlers.refresh(request("/auth/refresh", cookie));
    expect(failed.headers.get("location")).toBe(
      `${origin}/dashboard?auth=failed`,
    );
    expect(failed.headers.get("set-cookie")).toContain("rm_session=; Path=/;");
    expect(failed.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("ignores absent, malformed and forged sessions", async () => {
    expect(readSession(request("/dashboard"), key)).toBeNull();
    expect(
      readSession(request("/dashboard", "rm_session=bad"), key),
    ).toBeNull();
    const f = fixture();
    expect(
      (await f.handlers.refresh(request("/auth/refresh"))).headers.get(
        "location",
      ),
    ).toBe(`${origin}/dashboard?auth=failed`);
  });

  it("rejects authenticated envelopes containing incomplete session data", () => {
    const value = encryptRefreshToken(
      JSON.stringify({ accessToken: "fake-access" }),
      key,
      "session",
    );
    expect(
      readSession(request("/dashboard", `rm_session=${value}`), key),
    ).toBeNull();
  });

  it("returns a safe error if sign-in state cannot be encrypted", async () => {
    const f = fixture();
    const handlers = createAuthHandlers({
      origin,
      key: "invalid-key",
      auth: f.auth,
    });
    const response = await handlers.signin();
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?auth=failed`,
    );
  });

  it("clears the session if refreshed credentials have no verified user", async () => {
    const f = fixture();
    f.auth.getUser.mockResolvedValue(null as never);
    const cookie = sessionCookie(
      {
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAt: 0,
      },
      key,
      origin,
    ).split(";")[0];
    const response = await f.handlers.refresh(request("/auth/refresh", cookie));
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?auth=failed`,
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
