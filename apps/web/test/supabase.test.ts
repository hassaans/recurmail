import { describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "../lib/connections";
import { createSupabaseAdmin, createSupabaseAuth } from "../lib/supabase-auth";

const config = { url: "https://db.test", publishableKey: "fake-publishable" };

describe("native Supabase Auth adapter", () => {
  it("deletes Auth users with the secret key in apikey only", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const admin = createSupabaseAdmin({
      url: config.url,
      secretKey: "fake-secret",
      fetcher,
    });
    await admin.deleteUser("user/id");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://db.test/auth/v1/admin/users/user%2Fid",
    );
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      apikey: "fake-secret",
    });
  });

  it("signs in with only identity scopes and PKCE", () => {
    const auth = createSupabaseAuth(config);
    const url = new URL(
      auth.authorizationUrl(
        "https://app.test/auth/callback?state=s",
        "challenge",
      ),
    );
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("scopes")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.toString()).not.toContain("gmail.send");
  });

  it("exchanges PKCE server-side and discards Google provider credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "fake-access",
        refresh_token: "fake-session-refresh",
        expires_in: 3600,
        provider_token: "fake-google-access",
        provider_refresh_token: "fake-google-refresh",
      }),
    );
    const auth = createSupabaseAuth({ ...config, fetcher, now: () => 1000 });
    const session = await auth.exchangeCode("code", "verifier");
    expect(session).toEqual({
      accessToken: "fake-access",
      refreshToken: "fake-session-refresh",
      expiresAt: 3601000,
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://db.test/auth/v1/token?grant_type=pkce",
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      auth_code: "code",
      code_verifier: "verifier",
    });
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      apikey: "fake-publishable",
      "Content-Type": "application/json",
    });
    expect(JSON.stringify(session)).not.toContain("fake-google");
  });

  it("verifies identity against Auth instead of trusting cookie claims", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ id: "owner", email: "owner@gmail.com" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const auth = createSupabaseAuth({ ...config, fetcher });
    expect(await auth.getUser("fake-access")).toEqual({
      id: "owner",
      email: "owner@gmail.com",
    });
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      apikey: "fake-publishable",
      Authorization: "Bearer fake-access",
    });
    expect(await auth.getUser("forged-access")).toBeNull();
  });

  it("refreshes only Supabase session credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 10,
      }),
    );
    const auth = createSupabaseAuth({ ...config, fetcher, now: () => 0 });
    expect(await auth.refresh("old-refresh")).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 10000,
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      refresh_token: "old-refresh",
    });
  });

  it.each([
    { status: 400, body: { error: "secret" } },
    { status: 200, body: {} },
    {
      status: 200,
      body: { access_token: "access", refresh_token: "refresh", expires_in: 0 },
    },
  ])("rejects unusable sessions safely", async ({ status, body }) => {
    const auth = createSupabaseAuth({
      ...config,
      fetcher: vi.fn().mockResolvedValue(Response.json(body, { status })),
    });
    await expect(auth.exchangeCode("code", "verifier")).rejects.toThrow(
      "Sign-in failed",
    );
  });

  it("rejects an Auth response without a usable identity", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ email: "owner@gmail.com" }));
    expect(
      await createSupabaseAuth({ ...config, fetcher }).getUser("fake-access"),
    ).toBeNull();
  });
});

describe("connection persistence honors column grants and user isolation", () => {
  it("reads only safe fields with the user session and filters the owner", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json([
        {
          user_id: "owner",
          google_email: "owner@gmail.com",
          is_workspace: false,
          status: "connected",
          connected_at: "2026-10-14",
        },
      ]),
    );
    const store = createConnectionStore({
      ...config,
      secretKey: "fake-secret",
      fetcher,
    });
    expect(await store.readPublic("owner", "fake-access")).toMatchObject({
      google_email: "owner@gmail.com",
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).searchParams.get("select")).toBe(
      "user_id,google_email,is_workspace,status,connected_at",
    );
    expect(new URL(url).searchParams.get("user_id")).toBe("eq.owner");
    expect(init.headers).toEqual({
      apikey: "fake-publishable",
      Authorization: "Bearer fake-access",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    });
    expect(JSON.stringify(init)).not.toContain("fake-secret");
  });

  it("writes credentials with service access and pauses before deleting only the owner's rows", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const store = createConnectionStore({
      ...config,
      secretKey: "fake-secret",
      fetcher,
    });
    await store.save({
      user_id: "owner",
      google_email: "owner@gmail.com",
      is_workspace: false,
      encrypted_refresh_token: "v1.encrypted",
      status: "connected",
      connected_at: "2026-10-14",
    });
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      apikey: "fake-secret",
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    });
    await store.pauseSchedules("owner");
    await store.delete("owner");
    expect(fetcher.mock.calls[1][1].headers).toEqual({
      apikey: "fake-secret",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    });
    expect(new URL(fetcher.mock.calls[1][0]).pathname).toBe(
      "/rest/v1/schedules",
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      status: "paused",
    });
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get("user_id")).toBe(
      "eq.owner",
    );
    expect(fetcher.mock.calls[2][1].method).toBe("DELETE");
    expect(fetcher.mock.calls[2][1].headers).toEqual({
      apikey: "fake-secret",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    });
  });

  it("reads a credential only server-side and reports persistence failures without payloads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ encrypted_refresh_token: "v1.encrypted" }]),
      )
      .mockResolvedValueOnce(
        Response.json({ message: "secret" }, { status: 500 }),
      );
    const store = createConnectionStore({
      ...config,
      secretKey: "fake-secret",
      fetcher,
    });
    expect(await store.readEncryptedToken("owner")).toBe("v1.encrypted");
    expect(fetcher.mock.calls[0][1].headers).toEqual({
      apikey: "fake-secret",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    });
    await expect(store.pauseSchedules("owner")).rejects.toThrow(
      "Connection storage failed",
    );
  });

  it("returns no credential when the owner's connection is absent", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    expect(
      await createConnectionStore({
        ...config,
        secretKey: "fake-secret",
        fetcher,
      }).readEncryptedToken("owner"),
    ).toBeNull();
  });
});
