import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore, StoredConnection } from "../lib/connections";
import { decryptRefreshToken, encryptRefreshToken } from "../lib/crypto";
import { createGmailHandlers } from "../lib/gmail-flow";
import { createGoogleProvider } from "../lib/google";

const origin = "https://app.test";
const key = randomBytes(32).toString("base64");
const owner = { id: "owner", email: "owner@gmail.com" };
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const request = (
  path: string,
  cookie?: string,
  method = "GET",
  requestOrigin = origin,
) =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { Origin: requestOrigin } : {}),
    },
  });

function fixture(email = owner.email) {
  let connection: StoredConnection | null = null;
  const schedules = [
    { user_id: owner.id, status: "active" },
    { user_id: "other", status: "active" },
  ];
  const store: ConnectionStore = {
    readPublic: vi.fn(async () => connection),
    readEncryptedToken: vi.fn(
      async () => connection?.encrypted_refresh_token ?? null,
    ),
    save: vi.fn(async (row) => {
      connection = row;
    }),
    pauseSchedules: vi.fn(async (id) => {
      for (const row of schedules)
        if (row.user_id === id) row.status = "paused";
    }),
    delete: vi.fn(async () => {
      connection = null;
    }),
  };
  const google = {
    ...createGoogleProvider({ clientId: "id", clientSecret: "secret" }),
    exchangeCode: vi.fn(async () => "fake-gmail-refresh"),
    revoke: vi.fn(async () => {}),
  };
  const authenticate = vi.fn(async () => ({
    user: { ...owner, email },
    accessToken: "fake-access",
  }));
  const now = vi.fn(() => 1000);
  const handlers = createGmailHandlers({
    origin,
    key,
    store,
    google,
    authenticate,
    now,
  });
  const start = async () => {
    const response = await handlers.connect(
      request("/api/gmail/connect", undefined, "POST"),
    );
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(
      response.headers.get("location") ?? origin,
    ).searchParams.get("state");
    return { response, cookie, state };
  };
  return {
    handlers,
    start,
    store,
    google,
    authenticate,
    now,
    schedules,
    connection: () => connection,
  };
}

describe("Gmail connection HTTP flow with fake providers and persistence", () => {
  it("binds fresh S256 PKCE to the owner-encrypted state and sends its verifier only to the server exchange", async () => {
    const f = fixture();
    const { response, cookie, state } = await f.start();
    const consent = new URL(response.headers.get("location") ?? origin);
    const saved = JSON.parse(
      decryptRefreshToken(cookie.split("=")[1], key, owner.id),
    );
    expect(saved.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(saved.verifier).digest("base64url"),
    );
    expect(consent.searchParams.has("code_verifier")).toBe(false);
    expect(response.headers.get("set-cookie")).not.toContain(saved.verifier);
    expect(consent.toString()).not.toContain(saved.verifier);
    expect(() =>
      decryptRefreshToken(cookie.split("=")[1], key, "other"),
    ).toThrow();
    const second = await f.start();
    const secondSaved = JSON.parse(
      decryptRefreshToken(second.cookie.split("=")[1], key, owner.id),
    );
    expect(secondSaved.verifier).not.toBe(saved.verifier);
    const result = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(f.google.exchangeCode).toHaveBeenCalledWith(
      "fake-code",
      `${origin}/api/gmail/callback`,
      saved.verifier,
    );
    expect(await result.text()).not.toContain(saved.verifier);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      saved.verifier,
    );
  });

  it.each([undefined, "", 123, "bad verifier"])(
    "rejects state with invalid PKCE verifier %s before exchange",
    async (verifier) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      const saved = JSON.parse(
        decryptRefreshToken(cookie.split("=")[1], key, owner.id),
      );
      saved.verifier = verifier;
      const value = encryptRefreshToken(JSON.stringify(saved), key, owner.id);
      const result = await f.handlers.callback(
        request(
          `/api/gmail/callback?state=${state}&code=fake-code`,
          `rm_gmail_state=${value}`,
        ),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=failed`,
      );
      expect(f.google.exchangeCode).not.toHaveBeenCalled();
    },
  );
  it.each(["connect", "callback", "disconnect"] as const)(
    "logs %s failures without unverified identity, credentials or provider diagnostics",
    async (operation) => {
      const f = fixture();
      const secret =
        "fake-secret access-token refresh-token oauth-code owner@gmail.com provider-body";
      f.authenticate.mockRejectedValue(new Error(secret));
      const response = await f.handlers[operation](
        request(
          `/api/gmail/${operation}?code=oauth-code`,
          undefined,
          operation === "callback" ? "GET" : "POST",
        ),
      );
      expect(console.error).toHaveBeenCalledWith(
        `[ERROR] gmail_${operation}_failed`,
      );
      const logs = JSON.stringify(vi.mocked(console.error).mock.calls);
      for (const value of secret.split(" ")) expect(logs).not.toContain(value);
      expect(await response.text()).not.toContain("fake-secret");
      expect(response.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=${operation === "disconnect" ? "disconnect_failed" : "failed"}`,
      );
    },
  );
  it("connects, stores only owner-bound ciphertext, then revokes, deletes and pauses only the owner's schedules", async () => {
    const f = fixture();
    const { response, cookie, state } = await f.start();
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    expect(
      new URL(response.headers.get("location") ?? origin).searchParams.get(
        "login_hint",
      ),
    ).toBe(owner.email);
    const callback = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected`,
    );
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.connection()).toMatchObject({
      user_id: owner.id,
      google_email: owner.email,
      is_workspace: false,
      status: "connected",
    });
    const encrypted = f.connection()?.encrypted_refresh_token ?? "";
    expect(encrypted).not.toContain("fake-gmail-refresh");
    expect(decryptRefreshToken(encrypted, key, owner.id)).toBe(
      "fake-gmail-refresh",
    );
    expect(await callback.text()).not.toContain("fake-gmail-refresh");
    const disconnect = await f.handlers.disconnect(
      request("/api/gmail/disconnect", undefined, "POST"),
    );
    expect(disconnect.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=disconnected`,
    );
    expect(f.google.revoke).toHaveBeenCalledWith("fake-gmail-refresh");
    expect(f.connection()).toBeNull();
    expect(f.schedules).toEqual([
      { user_id: "owner", status: "paused" },
      { user_id: "other", status: "active" },
    ]);
  });

  it.each([
    "someone@workspace.test",
    "someone@GMAIL.COM",
    "someone@googlemail.com",
  ])(
    "classifies the signed-in account %s without another scope",
    async (email) => {
      const f = fixture(email);
      const { cookie, state } = await f.start();
      await f.handlers.callback(
        request(`/api/gmail/callback?state=${state}&code=code`, cookie),
      );
      expect(f.connection()?.is_workspace).toBe(
        email === "someone@workspace.test",
      );
    },
  );

  it("explains denied permission without exchanging a code or saving credentials", async () => {
    const f = fixture();
    const { cookie, state } = await f.start();
    const result = await f.handlers.callback(
      request(
        `/api/gmail/callback?state=${state}&error=access_denied&error_description=fake-secret`,
        cookie,
      ),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=denied`,
    );
    expect(f.google.exchangeCode).not.toHaveBeenCalled();
    expect(f.store.save).not.toHaveBeenCalled();
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    "missing",
    "mismatch",
    "expired",
    "tampered",
    "different-user",
    "different-email",
  ])("rejects %s OAuth state before exchange", async (kind) => {
    const f = fixture();
    let { cookie, state } = await f.start();
    if (kind === "missing") cookie = "";
    if (kind === "mismatch") state = "forged";
    if (kind === "expired") f.now.mockReturnValue(700000);
    if (kind === "tampered") cookie = "rm_gmail_state=v1.bad.state.cookie";
    if (kind === "different-user")
      f.authenticate.mockResolvedValue({
        user: { id: "other", email: owner.email },
        accessToken: "fake-access",
      });
    if (kind === "different-email")
      f.authenticate.mockResolvedValue({
        user: { ...owner, email: "other@gmail.com" },
        accessToken: "fake-access",
      });
    const result = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=code`, cookie),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=failed`,
    );
    expect(f.google.exchangeCode).not.toHaveBeenCalled();
    expect(f.store.save).not.toHaveBeenCalled();
  });

  it.each(["connect", "disconnect"] as const)(
    "rejects cross-origin %s and missing origin",
    async (method) => {
      const f = fixture();
      for (const attacker of ["https://attacker.test", "null", ""]) {
        expect(
          (
            await f.handlers[method](
              request(`/api/gmail/${method}`, undefined, "POST", attacker),
            )
          ).status,
        ).toBe(403);
      }
      expect(f.google.exchangeCode).not.toHaveBeenCalled();
      expect(f.store.pauseSchedules).not.toHaveBeenCalled();
    },
  );

  it.each(["connect", "callback", "disconnect"] as const)(
    "requires verified sign-in for %s",
    async (method) => {
      const f = fixture();
      f.authenticate.mockResolvedValue(null as never);
      const response = await f.handlers[method](
        request(
          `/api/gmail/${method}`,
          undefined,
          method === "callback" ? "GET" : "POST",
        ),
      );
      expect(response.headers.get("location")).toBe(
        `${origin}/dashboard?auth=required`,
      );
      expect(f.store.save).not.toHaveBeenCalled();
      expect(f.store.pauseSchedules).not.toHaveBeenCalled();
    },
  );

  it.each(["exchange", "save"])(
    "handles %s failure with a safe retry response",
    async (kind) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      if (kind === "exchange")
        f.google.exchangeCode.mockRejectedValue(new Error("fake-secret"));
      else vi.mocked(f.store.save).mockRejectedValue(new Error("fake-secret"));
      const result = await f.handlers.callback(
        request(`/api/gmail/callback?state=${state}&code=code`, cookie),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=failed`,
      );
      expect(await result.text()).not.toContain("fake-secret");
      expect(console.error).toHaveBeenCalledWith(
        "[ERROR] gmail_callback_failed",
      );
      if (kind === "save")
        expect(f.google.revoke).toHaveBeenCalledWith("fake-gmail-refresh");
    },
  );

  it.each(["pause", "revoke", "delete", "decrypt"])(
    "keeps a retryable credential when disconnect fails at %s",
    async (kind) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      await f.handlers.callback(
        request(`/api/gmail/callback?state=${state}&code=code`, cookie),
      );
      if (kind === "pause")
        vi.mocked(f.store.pauseSchedules).mockRejectedValue(
          new Error("fake-secret"),
        );
      if (kind === "revoke")
        f.google.revoke.mockRejectedValue(new Error("fake-secret"));
      if (kind === "delete")
        vi.mocked(f.store.delete).mockRejectedValue(new Error("fake-secret"));
      if (kind === "decrypt")
        vi.mocked(f.store.readEncryptedToken).mockResolvedValue(
          encryptRefreshToken("token", key, "other"),
        );
      const result = await f.handlers.disconnect(
        request("/api/gmail/disconnect", undefined, "POST"),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=disconnect_failed`,
      );
      expect(f.connection()).not.toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        "[ERROR] gmail_disconnect_failed",
      );
      if (kind !== "pause") expect(f.schedules[0].status).toBe("paused");
      if (kind === "pause" || kind === "decrypt")
        expect(f.google.revoke).not.toHaveBeenCalled();
    },
  );

  it("makes disconnect idempotent when there is no stored credential", async () => {
    const f = fixture();
    const result = await f.handlers.disconnect(
      request("/api/gmail/disconnect", undefined, "POST"),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=disconnected`,
    );
    expect(f.google.revoke).not.toHaveBeenCalled();
    expect(f.schedules[0].status).toBe("paused");
  });

  it("fails safely if connection initialization cannot encrypt state", async () => {
    const f = fixture();
    f.authenticate.mockRejectedValue(new Error("fake-secret"));
    const response = await f.handlers.connect(
      request("/api/gmail/connect", undefined, "POST"),
    );
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=failed`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each(["provider-error", "missing-code"])(
    "does not exchange a code for %s",
    async (kind) => {
      const f = fixture();
      const { cookie, state } = await f.start();
      const query =
        kind === "provider-error" ? "&error=temporarily_unavailable" : "";
      const response = await f.handlers.callback(
        request(`/api/gmail/callback?state=${state}${query}`, cookie),
      );
      expect(response.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=failed`,
      );
      expect(f.google.exchangeCode).not.toHaveBeenCalled();
    },
  );

  it("returns safe failure even if cleanup revocation also fails", async () => {
    const f = fixture();
    const { cookie, state } = await f.start();
    vi.mocked(f.store.save).mockRejectedValue(new Error("fake-secret"));
    f.google.revoke.mockRejectedValue(new Error("fake-secret"));
    const response = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=code`, cookie),
    );
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=failed`,
    );
    expect(await response.text()).not.toContain("fake-secret");
    expect(console.error).toHaveBeenCalledWith("[ERROR] gmail_callback_failed");
    expect(console.error).toHaveBeenCalledWith(
      "[ERROR] gmail_compensating_revocation_failed",
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /fake-secret|fake-gmail-refresh|owner@gmail.com/,
    );
  });
});
