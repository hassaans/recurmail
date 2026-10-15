import { describe, expect, it, vi } from "vitest";
import {
  ConnectionLimitError,
  createConnectionStore,
  MAX_GMAIL_CONNECTIONS,
} from "../lib/connections";
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

  it("exchanges a Google ID token with its raw nonce and discards provider tokens", async () => {
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
    const session = await auth.exchangeIdToken(
      "fake-google-id-token",
      "raw-nonce",
    );
    expect(session).toEqual({
      accessToken: "fake-access",
      refreshToken: "fake-session-refresh",
      expiresAt: 3601000,
    });
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://db.test/auth/v1/token?grant_type=id_token",
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      provider: "google",
      id_token: "fake-google-id-token",
      nonce: "raw-nonce",
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
    await expect(
      auth.exchangeIdToken("fake-google-id-token", "raw-nonce"),
    ).rejects.toThrow("Sign-in failed");
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
  const service = {
    apikey: "fake-secret",
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  const personal = "11111111-1111-4111-8111-111111111111";
  const work = "22222222-2222-4222-8222-222222222222";
  const connection = {
    user_id: "owner",
    google_email: "owner@gmail.com",
    is_workspace: false,
    encrypted_refresh_token: "v1.encrypted",
    status: "connected" as const,
    connected_at: "2026-10-14",
  };
  function store(fetcher: typeof fetch) {
    return createConnectionStore({
      ...config,
      secretKey: "fake-secret",
      fetcher,
    });
  }

  it("lists the user's accounts with their own session, oldest first, without any token", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: personal,
          user_id: "owner",
          google_email: "owner@gmail.com",
          is_workspace: false,
          status: "connected",
          connected_at: "2026-10-14",
          encrypted_refresh_token: "leaked",
        },
        {
          id: work,
          user_id: "owner",
          google_email: "work@company.test",
          is_workspace: true,
          status: "needs_reconnect",
          connected_at: "2026-10-15",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          user_id: "other",
          google_email: "other@gmail.com",
          is_workspace: false,
          status: "connected",
          connected_at: "2026-10-15",
        },
      ]),
    );
    const rows = await store(fetcher).list("owner", "fake-access");
    expect(rows).toEqual([
      {
        id: personal,
        user_id: "owner",
        google_email: "owner@gmail.com",
        is_workspace: false,
        status: "connected",
        connected_at: "2026-10-14",
      },
      {
        id: work,
        user_id: "owner",
        google_email: "work@company.test",
        is_workspace: true,
        status: "needs_reconnect",
        connected_at: "2026-10-15",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("leaked");
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).pathname).toBe("/rest/v1/gmail_connections");
    expect(new URL(url).searchParams.get("select")).toBe(
      "id,user_id,google_email,is_workspace,status,connected_at",
    );
    expect(new URL(url).searchParams.get("user_id")).toBe("eq.owner");
    expect(new URL(url).searchParams.get("order")).toBe(
      "connected_at.asc,id.asc",
    );
    expect(init.headers).toEqual({
      apikey: "fake-publishable",
      Authorization: "Bearer fake-access",
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    });
    expect(JSON.stringify(init)).not.toContain("fake-secret");
  });

  it("adds a new account with service access after checking the user's existing addresses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([{ id: work, google_email: "work@company.test" }]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store(fetcher).save(connection);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookup] = fetcher.mock.calls[0];
    expect(lookup.method).toBe("GET");
    expect(new URL(lookupUrl).searchParams.get("user_id")).toBe("eq.owner");
    expect(new URL(lookupUrl).searchParams.get("select")).toBe(
      "id,google_email",
    );
    expect(lookup.headers).toEqual(service);
    const [insertUrl, insert] = fetcher.mock.calls[1];
    expect(new URL(insertUrl).pathname).toBe("/rest/v1/gmail_connections");
    expect(new URL(insertUrl).search).toBe("");
    expect(insert.method).toBe("POST");
    expect(insert.headers).toEqual(service);
    expect(JSON.parse(insert.body)).toEqual(connection);
  });

  it("updates the row that already holds the same address, ignoring case, instead of adding one", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          { id: work, google_email: "work@company.test" },
          { id: personal, google_email: "Owner@GMAIL.com" },
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store(fetcher).save({ ...connection, status: "connected" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1];
    expect(init.method).toBe("PATCH");
    expect(new URL(url).searchParams.get("id")).toBe("eq." + personal);
    expect(new URL(url).searchParams.get("user_id")).toBe("eq.owner");
    expect(init.headers).toEqual(service);
    expect(JSON.parse(init.body)).toEqual({
      google_email: "owner@gmail.com",
      is_workspace: false,
      encrypted_refresh_token: "v1.encrypted",
      status: "connected",
      connected_at: "2026-10-14",
    });
  });

  it("refuses to add an account past the cap without writing", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json(
        Array.from({ length: MAX_GMAIL_CONNECTIONS }, (_, index) => ({
          id: "44444444-4444-4444-8444-" + String(index).padStart(12, "0"),
          google_email: "account" + index + "@company.test",
        })),
      ),
    );
    await expect(store(fetcher).save(connection)).rejects.toBeInstanceOf(
      ConnectionLimitError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe("GET");
  });

  it("gives the row a concurrent consent inserted first this token instead of failing", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(
        Response.json(
          { code: "23505", message: "duplicate key value" },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json([{ id: personal, google_email: "Owner@gmail.com" }]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await store(fetcher).save(connection);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([, init]) => init.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "PATCH",
    ]);
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get("user_id")).toBe(
      "eq.owner",
    );
    const [url, init] = fetcher.mock.calls[3];
    expect(new URL(url).searchParams.get("id")).toBe("eq." + personal);
    expect(new URL(url).searchParams.get("user_id")).toBe("eq.owner");
    expect(init.headers).toEqual(service);
    expect(JSON.parse(init.body)).toEqual({
      google_email: "owner@gmail.com",
      is_workspace: false,
      encrypted_refresh_token: "v1.encrypted",
      status: "connected",
      connected_at: "2026-10-14",
    });
  });

  it("fails a conflict that no row explains, and does not retry other refusals", async () => {
    const unexplained = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json([]));
    await expect(store(unexplained).save(connection)).rejects.toThrow(
      "Connection storage failed",
    );
    expect(unexplained).toHaveBeenCalledTimes(3);
    expect(unexplained.mock.calls[2][1].method).toBe("GET");
    const refused = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(store(refused).save(connection)).rejects.toThrow(
      "Connection storage failed",
    );
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it("pauses only that account's schedules before deleting it by id and owner", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const connections = store(fetcher);
    await connections.pauseSchedules("owner", personal);
    await connections.delete("owner", personal);
    const [pauseUrl, pause] = fetcher.mock.calls[0];
    expect(new URL(pauseUrl).pathname).toBe("/rest/v1/schedules");
    expect(pause.method).toBe("PATCH");
    expect(new URL(pauseUrl).searchParams.get("user_id")).toBe("eq.owner");
    expect(new URL(pauseUrl).searchParams.get("gmail_connection_id")).toBe(
      "eq." + personal,
    );
    expect(JSON.parse(pause.body)).toMatchObject({ status: "paused" });
    expect(pause.headers).toEqual(service);
    const [deleteUrl, remove] = fetcher.mock.calls[1];
    expect(new URL(deleteUrl).pathname).toBe("/rest/v1/gmail_connections");
    expect(remove.method).toBe("DELETE");
    expect(new URL(deleteUrl).searchParams.get("id")).toBe("eq." + personal);
    expect(new URL(deleteUrl).searchParams.get("user_id")).toBe("eq.owner");
    expect(remove.headers).toEqual(service);
  });

  it("reads one credential and every token only server-side, and reports failures without payloads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          {
            google_email: "owner@gmail.com",
            encrypted_refresh_token: "v1.encrypted",
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json([
          { encrypted_refresh_token: "v1.encrypted" },
          { encrypted_refresh_token: "v1.work" },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({ message: "secret" }, { status: 500 }),
      );
    const connections = store(fetcher);
    expect(await connections.readCredential("owner", personal)).toEqual({
      google_email: "owner@gmail.com",
      encrypted_refresh_token: "v1.encrypted",
    });
    const [credentialUrl, credential] = fetcher.mock.calls[0];
    expect(new URL(credentialUrl).searchParams.get("id")).toBe(
      "eq." + personal,
    );
    expect(new URL(credentialUrl).searchParams.get("user_id")).toBe("eq.owner");
    expect(new URL(credentialUrl).searchParams.get("select")).toBe(
      "google_email,encrypted_refresh_token",
    );
    expect(credential.headers).toEqual(service);
    expect(await connections.readEncryptedTokens("owner")).toEqual([
      "v1.encrypted",
      "v1.work",
    ]);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("select")).toBe(
      "encrypted_refresh_token",
    );
    expect(fetcher.mock.calls[1][1].headers).toEqual(service);
    await expect(connections.pauseSchedules("owner", personal)).rejects.toThrow(
      "Connection storage failed",
    );
  });

  it("returns no credential for a malformed id without a request, or for an absent row", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    const connections = store(fetcher);
    expect(await connections.readCredential("owner", "not-a-uuid")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await connections.readCredential("owner", personal)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
