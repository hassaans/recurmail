import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleProvider,
  GmailSendError,
  GoogleTokenError,
  grantedAccountFromIdToken,
} from "../lib/google";

afterEach(() => vi.unstubAllEnvs());

const sendScope = "https://www.googleapis.com/auth/gmail.send";
const connectScope = `openid email ${sendScope}`;
const now = Date.parse("2026-10-15T12:00:00Z");

function segment(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// An ID token as Google's token endpoint returns it: three base64url
// segments. The token arrives over TLS straight from Google, so the signature
// is not verified and any filler will do here.
function idToken(claims: Record<string, unknown> = {}, clientId = "id") {
  return `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iss: "https://accounts.google.com",
    aud: clientId,
    exp: Math.floor(now / 1000) + 3600,
    email: "owner@gmail.com",
    email_verified: true,
    ...claims,
  })}.fake-signature`;
}

function grant(
  claims: Record<string, unknown> = {},
  clientId = "id",
  body: Record<string, unknown> = {},
) {
  return {
    refresh_token: "fake-refresh",
    scope: connectScope,
    id_token: idToken(claims, clientId),
    ...body,
  };
}

function provider(fetcher: typeof fetch, clientId = "id") {
  return createGoogleProvider({
    clientId,
    clientSecret: "secret",
    fetcher,
    now: () => now,
  });
}

describe("separate Gmail OAuth provider", () => {
  it("uses an explicit loopback OAuth endpoint only outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetcher = vi.fn().mockResolvedValue(Response.json(grant()));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testOAuthOrigin: "http://127.0.0.1:3101",
      fetcher,
      now: () => now,
    });
    expect(
      new URL(
        google.authorizationUrl({
          redirectUri: "http://127.0.0.1:3100/api/gmail/callback",
          state: "nonce",
          email: "owner@gmail.com",
          challenge: "challenge",
        }),
      ).origin,
    ).toBe("http://127.0.0.1:3101");
    await google.exchangeCode(
      "code",
      "http://127.0.0.1:3100/api/gmail/callback",
      "verifier",
    );
    await google.revoke("fake-refresh");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3101/token",
      "http://127.0.0.1:3101/revoke",
    ]);
  });

  it.each([
    "https://attacker.test",
    "http://127.0.0.1.attacker.test",
    "http://127.1:3101",
    "http://0.0.0.0:3101",
    "http://user:secret@127.0.0.1:3101",
    "http://127.0.0.1:3101/path",
    "http://127.0.0.1:3101?secret=value",
    "http://127.0.0.1:3101#secret",
    "bad-url",
  ])("rejects unsafe test OAuth endpoint %s", (testOAuthOrigin) => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() =>
      createGoogleProvider({
        clientId: "id",
        clientSecret: "secret",
        testOAuthOrigin,
      }),
    ).toThrow("Test OAuth endpoint must be a loopback origin");
  });

  it("ignores test OAuth injection in production even when the injected URL is invalid", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetcher = vi.fn().mockResolvedValue(Response.json(grant()));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testOAuthOrigin: "bad-url-fake-secret",
      fetcher,
      now: () => now,
    });
    expect(
      new URL(
        google.authorizationUrl({
          redirectUri: "https://app.test/api/gmail/callback",
          state: "nonce",
          email: "owner@gmail.com",
          challenge: "challenge",
        }),
      ).origin,
    ).toBe("https://accounts.google.com");
    await google.exchangeCode(
      "code",
      "https://app.test/api/gmail/callback",
      "verifier",
    );
    await google.revoke("fake-refresh");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com/revoke",
    ]);
  });

  it("asks for send permission plus the granting account's identity, with the account chooser when adding", () => {
    const google = createGoogleProvider({
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const url = new URL(
      google.authorizationUrl({
        redirectUri: "https://app.test/api/gmail/callback",
        state: "nonce",
        challenge: "pkce-challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("scope")).toBe(connectScope);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("state")).toBe("nonce");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(url.toString()).not.toContain("test-secret");
  });

  it("pre-selects the account being reconnected instead of showing the chooser", () => {
    const google = createGoogleProvider({
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const url = new URL(
      google.authorizationUrl({
        redirectUri: "https://app.test/api/gmail/callback",
        state: "nonce",
        email: "work@company.test",
        challenge: "pkce-challenge",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(connectScope);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("work@company.test");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("exchanges the code in a server POST, returns the granted account and revokes in a POST body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(grant({}, "test-client")))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const google = provider(fetcher, "test-client");
    expect(
      await google.exchangeCode(
        "fake-code",
        "https://app.test/api/gmail/callback",
        "fake-verifier",
      ),
    ).toEqual({
      refreshToken: "fake-refresh",
      email: "owner@gmail.com",
      isWorkspace: false,
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(new URLSearchParams(init.body).get("client_secret")).toBe("secret");
    expect(new URLSearchParams(init.body).get("code")).toBe("fake-code");
    expect(new URLSearchParams(init.body).get("code_verifier")).toBe(
      "fake-verifier",
    );
    expect(String(url)).not.toContain("fake-verifier");
    await google.revoke("fake-refresh");
    expect(fetcher.mock.calls[1][0]).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
    expect(
      new URLSearchParams(fetcher.mock.calls[1][1].body).get("token"),
    ).toBe("fake-refresh");
  });

  it.each([
    ["work@company.test", true],
    ["someone@GMAIL.COM", false],
    ["someone@googlemail.com", false],
  ])(
    "takes the account from the ID token: %s is workspace=%s",
    async (email, isWorkspace) => {
      const google = provider(
        vi.fn().mockResolvedValue(Response.json(grant({ email }))),
      );
      expect(
        await google.exchangeCode("code", "https://app.test/cb", "verifier"),
      ).toEqual({ refreshToken: "fake-refresh", email, isWorkspace });
    },
  );

  it.each([
    `email openid ${sendScope}`,
    `${sendScope} openid email`,
    `openid https://www.googleapis.com/auth/userinfo.email ${sendScope}`,
    `${sendScope}   email  openid`,
  ])("accepts the granted scopes in any order: %s", async (scope) => {
    const google = provider(
      vi.fn().mockResolvedValue(Response.json(grant({}, "id", { scope }))),
    );
    await expect(
      google.exchangeCode("code", "https://app.test/cb", "verifier"),
    ).resolves.toMatchObject({ email: "owner@gmail.com" });
  });

  it.each([
    ["a provider error", { status: 400, body: { error: "fake-refresh" } }],
    [
      "no refresh token",
      { status: 200, body: { scope: connectScope, id_token: idToken() } },
    ],
    [
      "identity without send permission",
      {
        status: 200,
        body: {
          refresh_token: "fake-refresh",
          scope: "openid email",
          id_token: idToken(),
        },
      },
    ],
    [
      "a broader grant",
      {
        status: 200,
        body: grant({}, "id", {
          scope: `${connectScope} https://www.googleapis.com/auth/gmail.readonly`,
        }),
      },
    ],
    [
      "send permission without an ID token",
      {
        status: 200,
        body: { refresh_token: "fake-refresh", scope: connectScope },
      },
    ],
    [
      "an ID token from another issuer",
      { status: 200, body: grant({ iss: "https://attacker.test" }) },
    ],
    [
      "an ID token for another client",
      { status: 200, body: grant({ aud: "other-client" }) },
    ],
    [
      "an expired ID token",
      { status: 200, body: grant({ exp: Math.floor(now / 1000) - 1 }) },
    ],
    [
      "an unverified address",
      { status: 200, body: grant({ email_verified: false }) },
    ],
    ["a missing address", { status: 200, body: grant({ email: undefined }) }],
    [
      "a malformed ID token",
      { status: 200, body: grant({}, "id", { id_token: "not-a-jwt" }) },
    ],
    [
      "an ID token whose payload is not JSON",
      {
        status: 200,
        body: grant({}, "id", { id_token: "aGVhZGVy.!!!.c2ln" }),
      },
    ],
  ])(
    "rejects %s without exposing provider payloads",
    async (_label, { status, body }) => {
      const google = provider(
        vi.fn().mockResolvedValue(Response.json(body, { status })),
      );
      await expect(
        google.exchangeCode(
          "code",
          "https://app.test/callback",
          "fake-verifier",
        ),
      ).rejects.toThrow("Gmail permission could not be granted");
    },
  );

  it("refreshes access tokens and sends mail through the loopback Gmail origin outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "fake-gmail-access", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(Response.json({ id: "fake-message" }));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testOAuthOrigin: "http://127.0.0.1:3101",
      testGmailOrigin: "http://127.0.0.1:3101",
      fetcher,
    });
    await expect(google.refreshAccessToken("fake-refresh")).resolves.toBe(
      "fake-gmail-access",
    );
    await google.sendMessage("fake-gmail-access", "cmF3");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3101/token",
      "http://127.0.0.1:3101/gmail/v1/users/me/messages/send",
    ]);
    const refresh = new URLSearchParams(fetcher.mock.calls[0][1].body);
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("fake-refresh");
    expect(refresh.get("client_id")).toBe("id");
    expect(refresh.get("client_secret")).toBe("secret");
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe(
      "Bearer fake-gmail-access",
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ raw: "cmF3" });
  });

  it("uses the real Gmail origin in production even when a test origin is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "sent" }));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testGmailOrigin: "http://127.0.0.1:3101",
      fetcher,
    });
    await google.sendMessage("token", "cmF3");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
  });

  it.each([
    "https://attacker.test",
    "http://127.0.0.1.attacker.test",
    "http://0.0.0.0:3101",
    "http://127.0.0.1:3101/path",
    "bad-url",
  ])("rejects unsafe test Gmail endpoint %s", (testGmailOrigin) => {
    vi.stubEnv("NODE_ENV", "test");
    expect(() =>
      createGoogleProvider({
        clientId: "id",
        clientSecret: "secret",
        testGmailOrigin,
      }),
    ).toThrow("Test Gmail endpoint must be a loopback origin");
  });

  it("distinguishes an expired grant from other token failures", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "fake-secret-detail" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ expires_in: 3600 }));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      fetcher,
    });
    const expired = google.refreshAccessToken("fake-refresh");
    await expect(expired).rejects.toBeInstanceOf(GoogleTokenError);
    await expect(expired).rejects.toMatchObject({ code: "invalid_grant" });
    const outage = google.refreshAccessToken("fake-refresh");
    await expect(outage).rejects.toMatchObject({ code: "token_failed" });
    await expect(outage).rejects.not.toThrow("fake-secret-detail");
    await expect(
      google.refreshAccessToken("fake-refresh"),
    ).rejects.toMatchObject({ code: "token_failed" });
  });

  it("reports Gmail send failures by status only", async () => {
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      fetcher: vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "fake-secret-detail" } },
            { status: 429 },
          ),
        ),
    });
    const failure = google.sendMessage("token", "cmF3");
    await expect(failure).rejects.toBeInstanceOf(GmailSendError);
    await expect(failure).rejects.toMatchObject({ status: 429 });
    await expect(failure).rejects.not.toThrow("fake-secret-detail");
  });

  it("reads the granting account out of an ID token with Google's other issuer form", () => {
    expect(
      grantedAccountFromIdToken(
        idToken({ iss: "accounts.google.com", email: "team@company.test" }),
        "id",
        now,
      ),
    ).toEqual({ email: "team@company.test", isWorkspace: true });
    expect(grantedAccountFromIdToken(undefined, "id", now)).toBeNull();
    expect(grantedAccountFromIdToken(42, "id", now)).toBeNull();
    expect(
      grantedAccountFromIdToken(
        idToken({ email: `${"a".repeat(250)}@x.test` }),
        "id",
        now,
      ),
    ).toBeNull();
    expect(
      grantedAccountFromIdToken(
        idToken({ email: "not an address" }),
        "id",
        now,
      ),
    ).toBeNull();
  });

  it("treats an already-invalid token as revoked but surfaces temporary failures", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "invalid_token" }, { status: 400 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      fetcher,
    });
    await expect(google.revoke("fake-refresh")).resolves.toBeUndefined();
    await expect(google.revoke("fake-refresh")).rejects.toThrow(
      "Gmail revocation failed",
    );
  });
});
