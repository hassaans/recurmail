import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionAddressConflictError,
  ConnectionLimitError,
  type ConnectionStore,
  MAX_GMAIL_CONNECTIONS,
  type StoredConnection,
} from "../lib/connections";
import { decryptRefreshToken, encryptRefreshToken } from "../lib/crypto";
import { createGmailHandlers } from "../lib/gmail-flow";
import { createGoogleProvider, isWorkspaceAddress } from "../lib/google";

const origin = "https://app.test";
const key = randomBytes(32).toString("base64");
const owner = { id: "owner", email: "owner@gmail.com" };
const work = "work@company.test";
const ids = {
  personal: "11111111-1111-4111-8111-111111111111",
  work: "22222222-2222-4222-8222-222222222222",
};
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
// The Reconnect form posts the connection id; the Add form posts nothing.
const connectRequest = (id?: string) =>
  new Request(`${origin}/api/gmail/connect`, {
    method: "POST",
    headers: {
      Origin: origin,
      ...(id ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(id ? { body: new URLSearchParams({ id }).toString() } : {}),
  });

type Saved = StoredConnection & { id: string };

function fixture() {
  const connections: Saved[] = [];
  // The first two accounts get known ids so tests can address them.
  const nextIds = [ids.personal, ids.work];
  const schedules = [
    { user_id: owner.id, gmail_connection_id: ids.personal, status: "active" },
    { user_id: owner.id, gmail_connection_id: ids.work, status: "active" },
    { user_id: "other", gmail_connection_id: ids.personal, status: "active" },
  ];
  const own = (userId: string) =>
    connections.filter((connection) => connection.user_id === userId);
  const store: ConnectionStore = {
    list: vi.fn(async (userId) =>
      own(userId).map(({ encrypted_refresh_token: _token, ...row }) => row),
    ),
    readCredential: vi.fn(async (userId, id) => {
      const found = own(userId).find((connection) => connection.id === id);
      return found
        ? {
            google_email: found.google_email,
            encrypted_refresh_token: found.encrypted_refresh_token,
          }
        : null;
    }),
    readEncryptedTokens: vi.fn(async (userId) =>
      own(userId).map((connection) => connection.encrypted_refresh_token),
    ),
    save: vi.fn(async (row) => {
      // The same rules as the real store: the account id names the row, and
      // an address already held by a different account is refused.
      const wanted = row.google_email.toLowerCase();
      const mine = own(row.user_id);
      const existing =
        mine.find((connection) => connection.google_sub === row.google_sub) ??
        mine.find(
          (connection) => connection.google_email.toLowerCase() === wanted,
        );
      if (existing) {
        if (existing.google_sub !== row.google_sub)
          throw new ConnectionAddressConflictError();
        Object.assign(existing, row);
        return;
      }
      if (own(row.user_id).length >= MAX_GMAIL_CONNECTIONS)
        throw new ConnectionLimitError();
      connections.push({ ...row, id: nextIds.shift() ?? randomUUID() });
    }),
    pauseSchedules: vi.fn(async (userId, id) => {
      for (const row of schedules)
        if (row.user_id === userId && row.gmail_connection_id === id)
          row.status = "paused";
    }),
    delete: vi.fn(async (userId, id) => {
      const index = connections.findIndex(
        (connection) => connection.user_id === userId && connection.id === id,
      );
      if (index >= 0) connections.splice(index, 1);
    }),
  };
  // Google tells the callback which account granted the permission; the
  // fixture starts with the sign-in account and tests swap in others. The
  // account id follows the address unless a test says otherwise.
  const subFor = (email: string) => `google-sub-${email.toLowerCase()}`;
  const granted = (
    email: string,
    refreshToken = "fake-gmail-refresh",
    sub = subFor(email),
  ) => ({
    refreshToken,
    sub,
    email,
    isWorkspace: isWorkspaceAddress(email),
  });
  const google = {
    ...createGoogleProvider({ clientId: "id", clientSecret: "secret" }),
    exchangeCode: vi.fn(async () => granted(owner.email)),
    revoke: vi.fn(async () => {}),
  };
  const authenticate = vi.fn(async () => ({
    user: { ...owner },
    accessToken: "fake-access",
  }));
  const now = vi.fn(() => 1000);
  const analytics = {
    track: vi.fn(async () => {}),
    recordSignup: vi.fn(async () => false),
  };
  const handlers = createGmailHandlers({
    origin,
    key,
    store,
    google,
    authenticate,
    now,
    analytics,
  });
  const start = async (id?: string) => {
    const response = await handlers.connect(connectRequest(id));
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const location = new URL(response.headers.get("location") ?? origin);
    const state = location.searchParams.get("state");
    return { response, cookie, state, location };
  };
  // Runs the whole add flow for one granted account.
  const connect = async (
    email: string,
    refreshToken?: string,
    sub?: string,
  ) => {
    const { cookie, state } = await start();
    google.exchangeCode.mockResolvedValueOnce(
      granted(email, refreshToken, sub),
    );
    return handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
  };
  return {
    handlers,
    start,
    connect,
    granted,
    subFor,
    store,
    google,
    authenticate,
    now,
    analytics,
    schedules,
    connections,
    connection: (id = ids.personal) =>
      connections.find((connection) => connection.id === id) ?? null,
    // Marks a saved account the way the sender does after an invalid_grant.
    needsReconnect(id = ids.personal) {
      const connection = connections.find((row) => row.id === id);
      if (!connection) throw new Error(`No connection ${id}`);
      connection.status = "needs_reconnect";
    },
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
          `/api/gmail/${operation}?code=oauth-code&id=${ids.personal}`,
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

  it("adds the account Google granted through the chooser, names it, and stores only owner-bound ciphertext", async () => {
    const f = fixture();
    const { response, cookie, state, location } = await f.start();
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(response.headers.get("set-cookie")).toMatch(/Secure/);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    expect(location.searchParams.get("prompt")).toBe("consent select_account");
    expect(location.searchParams.has("login_hint")).toBe(false);
    const callback = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=owner%40gmail.com`,
    );
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.connection()).toMatchObject({
      id: ids.personal,
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
    expect(() => decryptRefreshToken(encrypted, key, "other")).toThrow();
    expect(await callback.text()).not.toContain("fake-gmail-refresh");
  });

  it("keeps every account the user adds as its own connection", async () => {
    const f = fixture();
    await f.connect(owner.email);
    const second = await f.connect(work, "fake-work-refresh");
    expect(second.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=work%40company.test`,
    );
    expect(f.connections.map((row) => [row.id, row.google_email])).toEqual([
      [ids.personal, owner.email],
      [ids.work, work],
    ]);
    expect(f.connection(ids.work)).toMatchObject({
      is_workspace: true,
      status: "connected",
    });
    expect(
      decryptRefreshToken(
        f.connection(ids.work)?.encrypted_refresh_token ?? "",
        key,
        owner.id,
      ),
    ).toBe("fake-work-refresh");
  });

  it("reconnecting a specific account hints it to Google and refreshes its token without a duplicate", async () => {
    const f = fixture();
    await f.connect(owner.email);
    await f.connect(work);
    f.needsReconnect(ids.work);
    const { cookie, state, location } = await f.start(ids.work);
    expect(location.searchParams.get("login_hint")).toBe(work);
    expect(location.searchParams.get("prompt")).toBe("consent");
    f.google.exchangeCode.mockResolvedValueOnce(
      f.granted(work, "fake-work-refresh-2"),
    );
    const callback = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=work%40company.test`,
    );
    expect(f.connections).toHaveLength(2);
    expect(f.connection(ids.work)).toMatchObject({ status: "connected" });
    expect(
      decryptRefreshToken(
        f.connection(ids.work)?.encrypted_refresh_token ?? "",
        key,
        owner.id,
      ),
    ).toBe("fake-work-refresh-2");
  });

  it("saves a different account than the one hinted as its own connection and says which one", async () => {
    const f = fixture();
    await f.connect(owner.email);
    f.needsReconnect();
    const { cookie, state, location } = await f.start(ids.personal);
    expect(location.searchParams.get("login_hint")).toBe(owner.email);
    f.google.exchangeCode.mockResolvedValueOnce(
      f.granted(work, "fake-work-refresh"),
    );
    const callback = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=work%40company.test`,
    );
    // The hinted account is untouched: still waiting for its own reconnect.
    expect(f.connection()).toMatchObject({
      google_email: owner.email,
      status: "needs_reconnect",
    });
    expect(f.connection(ids.work)).toMatchObject({
      google_email: work,
      status: "connected",
    });
  });

  it("keeps the same connection and its schedules when Google reports the account under a new address", async () => {
    const f = fixture();
    await f.connect(owner.email);
    await f.connect(work);
    f.needsReconnect(ids.personal);
    const { cookie, state } = await f.start(ids.personal);
    // Same Google account id, new address, fresh token.
    f.google.exchangeCode.mockResolvedValueOnce(
      f.granted("new-name@gmail.com", "fake-refresh-2", f.subFor(owner.email)),
    );
    const callback = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=new-name%40gmail.com`,
    );
    expect(f.connections).toHaveLength(2);
    expect(f.connection()).toMatchObject({
      google_email: "new-name@gmail.com",
      google_sub: f.subFor(owner.email),
      status: "connected",
    });
    expect(
      decryptRefreshToken(
        f.connection()?.encrypted_refresh_token ?? "",
        key,
        owner.id,
      ),
    ).toBe("fake-refresh-2");
    expect(f.schedules.filter((row) => row.user_id === owner.id)).toEqual([
      {
        user_id: owner.id,
        gmail_connection_id: ids.personal,
        status: "active",
      },
      { user_id: owner.id, gmail_connection_id: ids.work, status: "active" },
    ]);
  });

  it("refuses an address that a different Google account of the user's already holds, says which, and revokes the grant", async () => {
    const f = fixture();
    await f.connect(owner.email);
    const callback = await f.connect(
      "Owner@gmail.com",
      "fake-refresh-other",
      "google-sub-someone-else",
    );
    expect(callback.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=address_in_use&email=Owner%40gmail.com`,
    );
    expect(callback.headers.get("set-cookie")).toMatch(/rm_gmail_state=;/);
    // The row that holds the address keeps its account, token and status.
    expect(f.connections).toHaveLength(1);
    expect(f.connection()).toMatchObject({
      google_email: owner.email,
      google_sub: f.subFor(owner.email),
      status: "connected",
    });
    expect(
      decryptRefreshToken(
        f.connection()?.encrypted_refresh_token ?? "",
        key,
        owner.id,
      ),
    ).toBe("fake-gmail-refresh");
    expect(f.google.revoke).toHaveBeenCalledWith("fake-refresh-other");
    expect(console.error).not.toHaveBeenCalledWith(
      "[ERROR] gmail_callback_failed",
    );
  });

  it("ignores a reconnect id the user does not own and adds the granted account instead", async () => {
    const f = fixture();
    const { location, cookie, state } = await f.start(randomUUID());
    expect(location.searchParams.has("login_hint")).toBe(false);
    expect(location.searchParams.get("prompt")).toBe("consent select_account");
    await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(f.connections.map((row) => row.google_email)).toEqual([owner.email]);
  });

  it(`refuses to add an account past ${MAX_GMAIL_CONNECTIONS} before sending the user to Google, but still reconnects one`, async () => {
    const f = fixture();
    for (let index = 0; index < MAX_GMAIL_CONNECTIONS; index++)
      await f.connect(`account${index}@company.test`);
    expect(f.connections).toHaveLength(MAX_GMAIL_CONNECTIONS);
    const { response } = await f.start();
    expect(response.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=limit`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    const reconnect = await f.start(ids.personal);
    expect(
      new URL(reconnect.response.headers.get("location") ?? origin).origin,
    ).toBe("https://accounts.google.com");
    expect(reconnect.location.searchParams.get("login_hint")).toBe(
      "account0@company.test",
    );
  });

  it("reports the limit when the callback finds it reached, and revokes the grant it cannot keep", async () => {
    const f = fixture();
    const { cookie, state } = await f.start();
    vi.mocked(f.store.save).mockRejectedValueOnce(new ConnectionLimitError());
    const result = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=fake-code`, cookie),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=limit`,
    );
    expect(f.google.revoke).toHaveBeenCalledWith("fake-gmail-refresh");
    expect(console.error).not.toHaveBeenCalledWith(
      "[ERROR] gmail_callback_failed",
    );
    // The failure is recorded against the signed-in account.
    expect(f.analytics.track).toHaveBeenCalledWith(
      expect.any(Request),
      "gmail_connect_failed",
      {
        userId: owner.id,
        userEmail: owner.email,
        properties: { reason: "limit" },
      },
    );
  });

  it.each([
    "someone@workspace.test",
    "someone@GMAIL.COM",
    "someone@googlemail.com",
  ])(
    "records the account that granted the permission, %s, not the sign-in address",
    async (email) => {
      const f = fixture();
      await f.connect(email);
      expect(f.connection()).toMatchObject({
        google_email: email,
        is_workspace: email === "someone@workspace.test",
      });
      expect(f.connections).toHaveLength(1);
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

  it.each(["missing", "mismatch", "expired", "tampered", "different-user"])(
    "rejects %s OAuth state before exchange",
    async (kind) => {
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
      const result = await f.handlers.callback(
        request(`/api/gmail/callback?state=${state}&code=code`, cookie),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=failed`,
      );
      expect(f.google.exchangeCode).not.toHaveBeenCalled();
      expect(f.store.save).not.toHaveBeenCalled();
    },
  );

  it("binds state to the signed-in user, not their sign-in address", async () => {
    const f = fixture();
    const { cookie, state } = await f.start();
    f.authenticate.mockResolvedValue({
      user: { id: owner.id, email: "renamed@gmail.com" },
      accessToken: "fake-access",
    });
    const result = await f.handlers.callback(
      request(`/api/gmail/callback?state=${state}&code=code`, cookie),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=connected&email=owner%40gmail.com`,
    );
  });

  it.each(["connect", "disconnect"] as const)(
    "rejects cross-origin %s and missing origin",
    async (method) => {
      const f = fixture();
      for (const attacker of ["https://attacker.test", "null", ""]) {
        expect(
          (
            await f.handlers[method](
              request(
                `/api/gmail/${method}?id=${ids.personal}`,
                undefined,
                "POST",
                attacker,
              ),
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
          `/api/gmail/${method}?id=${ids.personal}`,
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

  it("disconnects one account by id: pauses only its schedules, revokes its token and keeps the others", async () => {
    const f = fixture();
    await f.connect(owner.email);
    await f.connect(work, "fake-work-refresh");
    const disconnect = await f.handlers.disconnect(
      request(`/api/gmail/disconnect?id=${ids.personal}`, undefined, "POST"),
    );
    expect(disconnect.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=disconnected&email=owner%40gmail.com`,
    );
    expect(f.google.revoke).toHaveBeenCalledTimes(1);
    expect(f.google.revoke).toHaveBeenCalledWith("fake-gmail-refresh");
    expect(f.connections.map((row) => row.google_email)).toEqual([work]);
    expect(f.schedules).toEqual([
      {
        user_id: owner.id,
        gmail_connection_id: ids.personal,
        status: "paused",
      },
      { user_id: owner.id, gmail_connection_id: ids.work, status: "active" },
      { user_id: "other", gmail_connection_id: ids.personal, status: "active" },
    ]);
  });

  it.each(["", "not-a-uuid", "../owner"])(
    "refuses a disconnect with the connection id %j without touching anything",
    async (id) => {
      const f = fixture();
      await f.connect(owner.email);
      const result = await f.handlers.disconnect(
        request(
          `/api/gmail/disconnect${id ? `?id=${encodeURIComponent(id)}` : ""}`,
          undefined,
          "POST",
        ),
      );
      expect(result.headers.get("location")).toBe(
        `${origin}/dashboard?gmail=disconnect_failed`,
      );
      expect(f.store.pauseSchedules).not.toHaveBeenCalled();
      expect(f.google.revoke).not.toHaveBeenCalled();
      expect(f.connections).toHaveLength(1);
    },
  );

  it.each(["pause", "revoke", "delete", "decrypt"])(
    "keeps a retryable credential when disconnect fails at %s",
    async (kind) => {
      const f = fixture();
      await f.connect(owner.email);
      if (kind === "pause")
        vi.mocked(f.store.pauseSchedules).mockRejectedValue(
          new Error("fake-secret"),
        );
      if (kind === "revoke")
        f.google.revoke.mockRejectedValue(new Error("fake-secret"));
      if (kind === "delete")
        vi.mocked(f.store.delete).mockRejectedValue(new Error("fake-secret"));
      if (kind === "decrypt")
        vi.mocked(f.store.readCredential).mockResolvedValue({
          google_email: owner.email,
          encrypted_refresh_token: encryptRefreshToken("token", key, "other"),
        });
      const result = await f.handlers.disconnect(
        request(`/api/gmail/disconnect?id=${ids.personal}`, undefined, "POST"),
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

  it("makes disconnect idempotent when the account is already gone", async () => {
    const f = fixture();
    const result = await f.handlers.disconnect(
      request(`/api/gmail/disconnect?id=${ids.personal}`, undefined, "POST"),
    );
    expect(result.headers.get("location")).toBe(
      `${origin}/dashboard?gmail=disconnected`,
    );
    expect(f.google.revoke).not.toHaveBeenCalled();
    expect(f.store.delete).not.toHaveBeenCalled();
    expect(f.schedules[0].status).toBe("paused");
  });

  it("fails safely if connection initialization cannot encrypt state", async () => {
    const f = fixture();
    f.authenticate.mockRejectedValue(new Error("fake-secret"));
    const response = await f.handlers.connect(connectRequest());
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
