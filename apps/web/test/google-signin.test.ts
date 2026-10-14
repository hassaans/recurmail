import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleSignIn } from "../lib/google-signin";

afterEach(() => vi.unstubAllEnvs());

describe("Google OIDC sign-in adapter", () => {
  it("builds Google's authorization request with PKCE and the hashed nonce", () => {
    vi.stubEnv("NODE_ENV", "production");
    const google = createGoogleSignIn({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      testOAuthOrigin: "http://127.0.0.1:3101",
    });
    const url = new URL(
      google.authorizationUrl({
        redirectUri: "https://app.test/auth/callback",
        state: "random-state",
        challenge: "pkce-challenge",
        nonceHash: "sha256-hex-nonce",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.test/auth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("random-state");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe("sha256-hex-nonce");
  });

  it("exchanges the code with Google using the matching callback and verifier", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id_token: "google-id-token",
        access_token: "discarded-google-access",
        refresh_token: "discarded-google-refresh",
      }),
    );
    const google = createGoogleSignIn({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      testOAuthOrigin: "http://127.0.0.1:3101",
      fetcher,
    });
    expect(
      await google.exchangeCode(
        "authorization-code",
        "http://app.test/auth/callback",
        "pkce-verifier",
      ),
    ).toBe("google-id-token");
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:3101/token");
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
    expect(fetcher.mock.calls[0][1].body.toString()).toBe(
      new URLSearchParams({
        code: "authorization-code",
        code_verifier: "pkce-verifier",
        client_id: "google-client-id",
        client_secret: "google-client-secret",
        redirect_uri: "http://app.test/auth/callback",
        grant_type: "authorization_code",
      }).toString(),
    );
  });

  it("rejects a Google token error without exposing its response", async () => {
    const google = createGoogleSignIn({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      fetcher: vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "provider diagnostic" }, { status: 400 }),
        ),
    });
    await expect(
      google.exchangeCode("code", "https://app.test/auth/callback", "verifier"),
    ).rejects.toThrow("Google sign-in failed");
  });
});
