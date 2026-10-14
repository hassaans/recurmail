import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleProvider } from "../lib/google";

afterEach(() => vi.unstubAllEnvs());

describe("separate Gmail OAuth provider", () => {
  it("uses an explicit loopback OAuth endpoint only outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        refresh_token: "fake-refresh",
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    );
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testOAuthOrigin: "http://127.0.0.1:3101",
      fetcher,
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
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        refresh_token: "fake-refresh",
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    );
    const google = createGoogleProvider({
      clientId: "id",
      clientSecret: "secret",
      testOAuthOrigin: "bad-url-fake-secret",
      fetcher,
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
  it("requests exactly send permission for the signed-in account with offline consent", () => {
    const google = createGoogleProvider({
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const url = new URL(
      google.authorizationUrl({
        redirectUri: "https://app.test/api/gmail/callback",
        state: "nonce",
        email: "owner@gmail.com",
        challenge: "pkce-challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("owner@gmail.com");
    expect(url.searchParams.get("include_granted_scopes")).not.toBe("true");
    expect(url.searchParams.get("state")).toBe("nonce");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(url.toString()).not.toContain("test-secret");
  });

  it("exchanges the code in a server POST and revokes in a POST body", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          refresh_token: "fake-refresh",
          scope: "https://www.googleapis.com/auth/gmail.send",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const google = createGoogleProvider({
      clientId: "test-client",
      clientSecret: "test-secret",
      fetcher,
    });
    expect(
      await google.exchangeCode(
        "fake-code",
        "https://app.test/api/gmail/callback",
        "fake-verifier",
      ),
    ).toBe("fake-refresh");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(new URLSearchParams(init.body).get("client_secret")).toBe(
      "test-secret",
    );
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
    { status: 400, body: { error: "fake-refresh" } },
    {
      status: 200,
      body: { scope: "https://www.googleapis.com/auth/gmail.send" },
    },
    { status: 200, body: { refresh_token: "fake-refresh", scope: "openid" } },
    {
      status: 200,
      body: {
        refresh_token: "fake-refresh",
        scope: "https://www.googleapis.com/auth/gmail.send openid",
      },
    },
  ])(
    "rejects unusable or broader grants without exposing provider payloads",
    async ({ status, body }) => {
      const google = createGoogleProvider({
        clientId: "test-client",
        clientSecret: "test-secret",
        fetcher: vi.fn().mockResolvedValue(Response.json(body, { status })),
      });
      await expect(
        google.exchangeCode(
          "code",
          "https://app.test/callback",
          "fake-verifier",
        ),
      ).rejects.toThrow("Gmail permission could not be granted");
    },
  );

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
