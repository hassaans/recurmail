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
  const google = {
    authorizationUrl: vi.fn(({ redirectUri, state, challenge, nonceHash }) => {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: "fake-google-client",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: nonceHash,
      }).toString();
      return url.toString();
    }),
    exchangeCode: vi.fn(async () => "fake-google-id-token"),
  };
  const auth = {
    ...createSupabaseAuth({
      url: "https://db.test",
      publishableKey: "fake-publishable",
    }),
    exchangeIdToken: vi.fn(async (_idToken: string, _nonce: string) => ({
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
  const handlers = createAuthHandlers({ origin, key, auth, google, now });
  const start = async () => {
    const response = await handlers.signin();
    const url = new URL(response.headers.get("location") ?? origin);
    const state = url.searchParams.get("state");
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    return { response, url, state, cookie, google };
  };
  return { auth, google, now, handlers, start };
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
        f.google.authorizationUrl.mockImplementation(() => {
          throw new Error(secret);
        });
        result = await f.handlers.signin();
      } else if (operation === "callback") {
        const { cookie, state } = await f.start();
        f.google.exchangeCode.mockRejectedValue(new Error(secret));
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
  it("uses a fresh state, S256 PKCE and hashed nonce and stores only Supabase tokens", async () => {
    const f = fixture();
    const { response, url, state, cookie } = await f.start();
    const saved = JSON.parse(
      decryptRefreshToken(cookie.split("=")[1], key, "auth-state"),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("fake-google-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/callback`,
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(saved.verifier).digest("base64url"),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe(
      createHash("sha256").update(saved.nonce).digest("hex"),
    );
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const second = await f.start();
    expect(second.state).not.toBe(state);
    const result = await f.handlers.callback(
      request(`/auth/callback?state=${state}&code=code`, cookie),
    );
    expect(result.headers.get("location")).toBe(`${origin}/dashboard`);
    expect(f.google.exchangeCode).toHaveBeenCalledWith(
      "code",
      `${origin}/auth/callback`,
      saved.verifier,
    );
    expect(f.auth.exchangeIdToken).toHaveBeenCalledWith(
      "fake-google-id-token",
      saved.nonce,
    );
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
      expect(f.google.exchangeCode).not.toHaveBeenCalled();
    },
  );

  it.each(["google-token", "supabase-id-token", "nonce-mismatch", "identity"])(
    "does not create a session on %s failure",
    async (kind) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      if (kind === "google-token")
        f.google.exchangeCode.mockRejectedValue(new Error("fake-secret"));
      else if (kind === "supabase-id-token")
        f.auth.exchangeIdToken.mockRejectedValue(new Error("fake-secret"));
      else if (kind === "nonce-mismatch")
        f.auth.exchangeIdToken.mockRejectedValue(
          new Error("nonce mismatch rejected by Supabase"),
        );
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

  it("rejects a Google ID token when Supabase rejects its nonce", async () => {
    const f = fixture();
    const { cookie, state } = await f.start();
    f.auth.exchangeIdToken.mockImplementation(async (_idToken, nonce) => {
      if (nonce !== "nonce-bound-to-google-id-token")
        throw new Error("nonce mismatch");
      return {
        accessToken: "fake-access",
        refreshToken: "fake-session-refresh",
        expiresAt: 10000,
      };
    });
    const response = await f.handlers.callback(
      request(`/auth/callback?state=${state}&code=code`, cookie),
    );
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?auth=failed`,
    );
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("rm_session=")),
    ).toBe(false);
  });

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
      google: f.google,
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
