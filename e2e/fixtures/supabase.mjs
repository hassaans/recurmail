import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createServer } from "node:http";

// Local fake OAuth/Supabase/Gmail boundary, never loaded by the application.
// Ports default to 3100/3101 (CI); both env vars let a second copy run alongside.
const fakePort = process.env.RECURMAIL_E2E_FAKE_PORT?.trim() || "3101";
const webPort = process.env.RECURMAIL_E2E_WEB_PORT?.trim() || "3100";
const origin = `http://127.0.0.1:${fakePort}`;
const appOrigin = `http://127.0.0.1:${webPort}`;
const gmailScope = "https://www.googleapis.com/auth/gmail.send";
// Connecting asks for send permission plus the identity of the account that
// grants it, so the app can record which account the user actually picked.
const connectScope = `openid email ${gmailScope}`;
const publicColumns =
  "id,user_id,google_email,is_workspace,status,connected_at";
const connectionColumns = [
  "id",
  "user_id",
  "google_email",
  "google_sub",
  "is_workspace",
  "status",
  "connected_at",
  "encrypted_refresh_token",
];
const connectionStatuses = ["connected", "needs_reconnect", "disconnected"];
const maxConnections = 10;
const scheduleColumns = [
  "id",
  "user_id",
  "subject",
  "body_text",
  "body_html",
  "to",
  "cc",
  "bcc",
  "rrule",
  "timezone",
  "source",
  "status",
  "next_send_at",
  "gmail_connection_id",
  "created_at",
  "updated_at",
];
const scenarios = new Map();
const codes = new Map();
const idTokens = new Map();
// Analytics rows are global: most come from anonymous browsers that belong
// to no scenario. Tests pick theirs out by browser id or user id.
const analyticsEvents = [];
const userAttribution = new Map();
const eventColumns = [
  "event",
  "anonymous_id",
  "session_id",
  "user_id",
  "user_email",
  "path",
  "referrer_host",
  "source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "device",
  "ip_address",
  "user_agent",
  "accept_language",
  "country",
  "region",
  "city",
  "is_bot",
  "properties",
];
const attributionColumns = [
  "user_id",
  "anonymous_id",
  "user_email",
  "signup_ip",
  "signup_user_agent",
  "first_source",
  "first_referrer_host",
  "first_utm_source",
  "first_utm_medium",
  "first_utm_campaign",
  "first_utm_term",
  "first_utm_content",
  "first_landing_path",
  "first_seen_at",
  "signed_up_at",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullableUuid = (value) =>
  value === null || value === undefined || UUID.test(value);
const nullableText = (value, max) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.length <= max);

function newUser(domain = "gmail.com") {
  const id = randomUUID();
  return {
    id,
    email: `${id}@${domain}`,
    accessToken: `fake-secret-session-access-${id}`,
    refreshToken: `fake-secret-session-refresh-${id}`,
  };
}

function newSchedule(user, status = "active", connectionId = null) {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + 3600000);
  next.setUTCMilliseconds(0);
  const start = next.toISOString().replace(/[-:]/g, "").replace(".000", "");
  return {
    id: randomUUID(),
    user_id: user.id,
    subject: "Fixture reminder",
    body_text: "A recurring fixture reminder.",
    body_html: null,
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    rrule: `DTSTART:${start}\nRRULE:FREQ=DAILY`,
    timezone: "UTC",
    source: "web",
    status,
    next_send_at: next.toISOString(),
    gmail_connection_id: connectionId,
    created_at: now,
    updated_at: now,
  };
}

const isWorkspaceAddress = (email) => !/@(gmail|googlemail)\.com$/i.test(email);

// Rows seeded without a Google account id stand for connections written
// before the id was stored; the app fills the id in when they reconnect.
function newConnection(
  user,
  email,
  status,
  encryptedRefreshToken,
  googleSub = null,
) {
  return {
    id: randomUUID(),
    user_id: user.id,
    google_email: email,
    google_sub: googleSub,
    is_workspace: isWorkspaceAddress(email),
    status,
    connected_at: "2026-10-14T09:00:00.000Z",
    encrypted_refresh_token: encryptedRefreshToken,
  };
}

// The fake Google account id for an address. A test that renames an account
// passes the old id with the new address instead.
const googleSubFor = (email) =>
  createHash("sha256").update(email.toLowerCase()).digest("hex");

// Mirrors the column check from migration 0007: null, or 1 to 255 characters.
const validGoogleSub = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.length >= 1 && value.length <= 255);

// Mirrors the two unique indexes from migration 0007: one row per address
// (ignoring case) and one per Google account id, among a user's rows.
function uniqueConflict(existing, row) {
  if (
    existing.some(
      (candidate) =>
        candidate.google_email.toLowerCase() === row.google_email.toLowerCase(),
    )
  )
    return "gmail_connections_user_id_lower_email_key";
  if (
    typeof row.google_sub === "string" &&
    existing.some((candidate) => candidate.google_sub === row.google_sub)
  )
    return "gmail_connections_user_id_google_sub_key";
  return null;
}

function encryptedToken(token, userId) {
  const key = Buffer.alloc(32, 7);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

// Google issues one refresh token per granting account. The owner's own
// address gets a stable token so tests can name it before the grant happens.
// One refresh token per Google account. The default id derives from the
// address, so a plain grant for an address always gets that address's token.
function gmailRefreshTokenFor(scenario, email, sub = googleSubFor(email)) {
  const key = sub;
  let token = scenario.gmailRefreshTokens.get(key);
  if (!token) {
    token = `fake-secret-gmail-refresh-${randomUUID()}`;
    scenario.gmailRefreshTokens.set(key, token);
  }
  return token;
}

// The ID token Google returns alongside the grant, naming the account that
// granted it. Only the claims matter: the app reads them without verifying
// the signature because the token arrives straight from Google over TLS.
function idTokenFor(email, sub = googleSubFor(email)) {
  const segment = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    segment({ alg: "RS256", typ: "JWT" }),
    segment({
      iss: "https://accounts.google.com",
      aud: "fake-google-client",
      sub,
      email,
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "fake-signature",
  ].join(".");
}

function newScenario() {
  const owner = newUser();
  const connected = newUser();
  const reconnect = newUser("workspace.test");
  const connectedAccount = newConnection(
    connected,
    connected.email,
    "connected",
    "fixture-ciphertext",
  );
  const reconnectAccount = newConnection(
    reconnect,
    reconnect.email,
    "needs_reconnect",
    "fixture-ciphertext",
  );
  const scenario = {
    id: randomUUID(),
    owner,
    connected,
    reconnect,
    foreignUserId: connected.id,
    gmailAccessToken: `fake-secret-gmail-access-${owner.id}`,
    gmailRefreshToken: `fake-secret-gmail-refresh-${owner.id}`,
    // A second address the owner can grant from the account chooser.
    workEmail: `${owner.id}@company.test`,
    connectionIds: {
      connected: connectedAccount.id,
      reconnect: reconnectAccount.id,
    },
    connections: new Map([
      [connectedAccount.id, connectedAccount],
      [reconnectAccount.id, reconnectAccount],
    ]),
    // The owner connected an account once and removed it again, so their
    // schedules are paused with no sender, as the database leaves them. The
    // reconnect user's schedule is paused too: a failed send marks the
    // account and pauses its schedules in the same step.
    schedules: [
      newSchedule(owner, "paused"),
      newSchedule(owner, "paused"),
      newSchedule(connected, "active", connectedAccount.id),
      newSchedule(reconnect, "paused", reconnectAccount.id),
    ],
    sendLogs: [],
    revokedTokens: [],
    exchanges: [],
    deletedUserIds: new Set(),
    revokeFails: false,
    // Fake Gmail: messages accepted by users/me/messages/send, parsed headers only.
    gmailMessages: [],
    testSends: [],
    expiredGrant: false,
    gmailFails: false,
    gmailRefreshTokens: new Map(),
    nextGrant: null,
  };
  scenario.gmailRefreshTokens.set(
    googleSubFor(owner.email),
    scenario.gmailRefreshToken,
  );
  scenarios.set(scenario.id, scenario);
  return scenario;
}

/** Give the already-connected personal account a real, decryptable refresh token. */
function connectForTestSend(scenario) {
  const connection = scenario.connections.get(scenario.connectionIds.connected);
  connection.encrypted_refresh_token = encryptedToken(
    scenario.gmailRefreshToken,
    scenario.connected.id,
  );
  return { user_id: scenario.connected.id, connection_id: connection.id };
}

/** RFC 2822 headers from a Gmail `raw` message; folded lines are unfolded. */
function parseMimeHeaders(raw) {
  const message = Buffer.from(raw, "base64url").toString("utf8");
  const [block, ...parts] = message.split("\r\n\r\n");
  const headers = {};
  for (const line of block.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0)
      headers[line.slice(0, colon).toLowerCase()] = line
        .slice(colon + 1)
        .trim();
  }
  // Body parts are base64 wrapped at 76 characters, a multiple of 4, so each
  // line decodes alone. `text` holds the words the user typed.
  const text = parts
    .join("\r\n\r\n")
    .split("\r\n")
    .filter((line) => /^[A-Za-z0-9+/]+=*$/.test(line))
    .map((line) => Buffer.from(line, "base64").toString("utf8"))
    .join("\n");
  return { headers, message, text };
}

function findUser(predicate) {
  for (const scenario of scenarios.values()) {
    for (const user of [
      scenario.owner,
      scenario.connected,
      scenario.reconnect,
    ]) {
      if (predicate(user)) return { user, scenario };
    }
  }
  return null;
}

function scenarioFromCookie(req) {
  const id = req.headers.cookie
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith("fake_scenario="))
    ?.slice("fake_scenario=".length);
  return scenarios.get(id) ?? null;
}

function connectionsOf(scenario, userId) {
  return [...scenario.connections.values()].filter(
    (row) => row.user_id === userId,
  );
}

// Mirrors the foreign key's "on delete set null" and the trigger that pauses
// a schedule whose sender goes away.
function removeConnection(scenario, id) {
  scenario.connections.delete(id);
  for (const schedule of scenario.schedules)
    if (schedule.gmail_connection_id === id) {
      schedule.gmail_connection_id = null;
      if (schedule.status !== "paused") schedule.status = "paused";
    }
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const reply = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const redirect = (callback) => {
    res.writeHead(302, { Location: callback.toString() });
    res.end();
  };
  try {
    if (url.pathname === "/health") return reply(200, { ready: true });
    if (url.pathname === "/__test/analytics" && req.method === "GET") {
      // Every stored row for one browser or one user.
      const anonymousId = url.searchParams.get("anonymous_id");
      const userId = url.searchParams.get("user_id");
      return reply(200, {
        events: analyticsEvents.filter(
          (row) =>
            (anonymousId && row.anonymous_id === anonymousId) ||
            (userId && row.user_id === userId),
        ),
        attribution: [...userAttribution.values()].filter(
          (row) =>
            (anonymousId && row.anonymous_id === anonymousId) ||
            (userId && row.user_id === userId),
        ),
      });
    }
    if (url.pathname === "/__test/scenarios" && req.method === "POST") {
      const {
        connections,
        schedules,
        revokedTokens,
        exchanges,
        deletedUserIds,
        revokeFails,
        gmailMessages,
        testSends,
        expiredGrant,
        gmailFails,
        gmailRefreshTokens,
        nextGrant,
        ...scenario
      } = newScenario();
      return reply(201, scenario);
    }
    if (url.pathname.startsWith("/__test/scenarios/")) {
      const [id, setup] = url.pathname
        .slice("/__test/scenarios/".length)
        .split("/");
      const scenario = scenarios.get(id);
      if (!scenario) return reply(404, { error: "unknown test scenario" });
      if (setup === "account-deletion" && req.method === "POST") {
        // The owner's own address, connected with a real encrypted token so
        // a disconnect or account deletion can revoke it.
        const row = newConnection(
          scenario.owner,
          scenario.owner.email,
          "connected",
          encryptedToken(scenario.gmailRefreshToken, scenario.owner.id),
        );
        scenario.connections.set(row.id, row);
        return reply(200, {
          user_id: scenario.owner.id,
          connection_id: row.id,
        });
      }
      if (setup === "second-account" && req.method === "POST") {
        // A second, work address on the owner's account with its own token.
        const token = gmailRefreshTokenFor(scenario, scenario.workEmail);
        const row = newConnection(
          scenario.owner,
          scenario.workEmail,
          "connected",
          encryptedToken(token, scenario.owner.id),
          googleSubFor(scenario.workEmail),
        );
        row.connected_at = "2026-10-14T10:00:00.000Z";
        scenario.connections.set(row.id, row);
        return reply(200, {
          user_id: scenario.owner.id,
          connection_id: row.id,
          google_sub: row.google_sub,
          refresh_token: token,
        });
      }
      if (setup === "grant" && req.method === "POST") {
        // Which account the fake Google chooser picks on the next consent.
        // An optional `sub` stands in for an account whose address changed
        // (the old id with a new address) or for a different account that
        // now owns an address (a new id with a known address).
        const input = JSON.parse(await body(req));
        if (
          typeof input.email !== "string" ||
          !input.email.includes("@") ||
          (input.sub !== undefined && typeof input.sub !== "string")
        )
          return reply(400, { error: "invalid grant fixture" });
        scenario.nextGrant = {
          email: input.email,
          sub: input.sub ?? googleSubFor(input.email),
        };
        return reply(200, {
          email: input.email,
          sub: scenario.nextGrant.sub,
          refresh_token: gmailRefreshTokenFor(
            scenario,
            input.email,
            scenario.nextGrant.sub,
          ),
        });
      }
      if (setup === "revoke-failure" && req.method === "POST") {
        scenario.revokeFails = true;
        return reply(200, { revoke_fails: true });
      }
      if (setup === "test-send" && req.method === "POST") {
        // Optional `used`: test emails already sent by this user in the last hour.
        const input = JSON.parse((await body(req)) || "{}");
        const used = Number.isInteger(input.used) ? input.used : 0;
        for (let index = 0; index < used; index += 1)
          scenario.testSends.push({
            id: randomUUID(),
            user_id: scenario.connected.id,
            sent_at: new Date(Date.now() - (index + 1) * 60000).toISOString(),
          });
        return reply(200, { ...connectForTestSend(scenario), used });
      }
      if (setup === "expired-grant" && req.method === "POST") {
        scenario.expiredGrant = true;
        return reply(200, { ...connectForTestSend(scenario), expired: true });
      }
      if (setup === "gmail-failure" && req.method === "POST") {
        scenario.gmailFails = true;
        return reply(200, {
          ...connectForTestSend(scenario),
          gmail_fails: true,
        });
      }
      if (setup === "schedule-api" && req.method === "POST") {
        // Isolate forecasts for the already-connected personal Gmail account.
        // Keep foreign owner rows so browser tests still exercise owner filtering.
        scenario.schedules = scenario.schedules.filter(
          (schedule) => schedule.user_id !== scenario.connected.id,
        );
        return reply(200, { user_id: scenario.connected.id });
      }
      if (setup === "finished-schedules" && req.method === "POST") {
        // Two schedules the cron paused because their rules ran out: one
        // after a fixed number of sends, one on an end date. Both keep the
        // stale next_send_at the cron leaves behind.
        const user = scenario.connected;
        const connectionId = scenario.connectionIds.connected;
        const day = 86400000;
        const started = new Date(Date.now() - 3 * day);
        started.setUTCHours(9, 0, 0, 0);
        const stamp = (date) =>
          date.toISOString().replace(/[-:]/g, "").replace(".000", "");
        const lastSend = new Date(started.getTime() + 2 * day);
        const counted = {
          ...newSchedule(user, "paused", connectionId),
          subject: "Quarterly reminder",
          rrule: `DTSTART:${stamp(started)}\nRRULE:FREQ=DAILY;COUNT=3`,
          next_send_at: lastSend.toISOString(),
        };
        const endDay = new Date(Date.now() - day).toISOString().slice(0, 10);
        const dated = {
          ...newSchedule(user, "paused", connectionId),
          subject: "Launch countdown",
          rrule: `DTSTART:${stamp(started)}\nRRULE:FREQ=DAILY;UNTIL=${endDay.replace(/-/g, "")}T235959Z`,
          next_send_at: lastSend.toISOString(),
        };
        scenario.schedules.push(counted, dated);
        for (let index = 0; index < 3; index += 1) {
          const at = new Date(started.getTime() + index * day).toISOString();
          scenario.sendLogs.push({
            id: randomUUID(),
            schedule_id: counted.id,
            user_id: user.id,
            scheduled_for: at,
            attempted_at: at,
            status: "sent",
            error_code: null,
          });
        }
        return reply(200, {
          counted: counted.id,
          dated: dated.id,
          ended_on: endDay,
        });
      }
      if (setup === "send-log" && req.method === "POST") {
        const input = JSON.parse(await body(req));
        const schedule = scenario.schedules.find(
          (row) =>
            row.id === input.schedule_id &&
            row.user_id === scenario.connected.id,
        );
        if (!schedule || !Array.isArray(input.rows))
          return reply(400, { error: "invalid history fixture" });
        scenario.sendLogs = input.rows.map((row) => ({
          id: randomUUID(),
          schedule_id: schedule.id,
          user_id: scenario.connected.id,
          scheduled_for: row.scheduled_for,
          attempted_at: row.attempted_at,
          status: row.status,
          error_code: row.error_code,
        }));
        return reply(200, { rows: scenario.sendLogs.length });
      }
      if (setup) return reply(404, { error: "unknown test setup" });
      if (req.method === "DELETE") {
        scenarios.delete(id);
        for (const [code, grant] of codes)
          if (grant.scenario.id === id) codes.delete(code);
        for (const [token, grant] of idTokens)
          if (grant.user.id === scenario.owner.id) idTokens.delete(token);
        return reply(200, { deleted: true });
      }
      return reply(200, {
        connections: [...scenario.connections.values()],
        schedules: scenario.schedules,
        sendLogs: scenario.sendLogs,
        revokedTokens: scenario.revokedTokens,
        exchanges: scenario.exchanges,
        deletedUserIds: [...scenario.deletedUserIds],
        gmailMessages: scenario.gmailMessages,
        testSends: scenario.testSends,
      });
    }
    if (
      url.pathname === "/o/oauth2/v2/auth" &&
      url.searchParams.get("scope") === "openid email"
    ) {
      const scenario = scenarioFromCookie(req);
      const callback = new URL(url.searchParams.get("redirect_uri"));
      if (
        !scenario ||
        url.searchParams.get("client_id") !== "fake-google-client" ||
        url.searchParams.get("scope") !== "openid email" ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("code_challenge") ||
        !url.searchParams.get("nonce") ||
        !url.searchParams.get("state") ||
        callback.origin !== appOrigin ||
        callback.pathname !== "/auth/callback"
      )
        return reply(400, { error: "unexpected authorization" });
      const code = `fake-secret-auth-code-${randomUUID()}`;
      codes.set(code, {
        kind: "auth",
        scenario,
        user: scenario.owner,
        challenge: url.searchParams.get("code_challenge"),
        nonceHash: url.searchParams.get("nonce"),
        redirectUri: callback.toString(),
      });
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", code);
      return redirect(callback);
    }
    if (url.pathname === "/auth/v1/token" && req.method === "POST") {
      if (req.headers.apikey !== "fake-publishable-key")
        return reply(401, { error: "invalid API key" });
      const data = JSON.parse(await body(req));
      let user;
      if (url.searchParams.get("grant_type") === "id_token") {
        const grant = idTokens.get(data.id_token);
        idTokens.delete(data.id_token);
        if (
          data.provider !== "google" ||
          !grant ||
          createHash("sha256").update(data.nonce).digest("hex") !==
            grant.nonceHash
        )
          return reply(400, { error: "invalid_id_token" });
        user = grant.user;
      } else
        user = findUser(
          (candidate) => candidate.refreshToken === data.refresh_token,
        )?.user;
      if (!user) return reply(400, { error: "invalid_grant" });
      return reply(200, {
        access_token: user.accessToken,
        refresh_token: user.refreshToken,
        expires_in: 3600,
        provider_token: "fake-google-access-must-be-discarded",
        provider_refresh_token: "fake-google-refresh-must-be-discarded",
      });
    }
    if (url.pathname === "/o/oauth2/v2/auth") {
      // Gmail consent. Adding an account shows Google's chooser, so there is
      // no login_hint; reconnecting names the account and skips the chooser.
      // The granting account is whatever the test queued, else the hinted
      // one, else the signed-in owner's own address.
      const scenario = scenarioFromCookie(req);
      const hint = url.searchParams.get("login_hint");
      const callback = new URL(url.searchParams.get("redirect_uri"));
      if (
        !scenario ||
        url.searchParams.get("scope") !== connectScope ||
        url.searchParams.get("client_id") !== "fake-google-client" ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("access_type") !== "offline" ||
        url.searchParams.get("prompt") !==
          (hint ? "consent" : "consent select_account") ||
        url.searchParams.get("include_granted_scopes") !== "false" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("code_challenge") ||
        url.searchParams.has("code_verifier") ||
        !url.searchParams.get("state") ||
        callback.origin !== appOrigin ||
        callback.pathname !== "/api/gmail/callback"
      )
        return reply(400, { error: "unexpected Gmail authorization" });
      const email = scenario.nextGrant?.email ?? hint ?? scenario.owner.email;
      const sub = scenario.nextGrant?.sub ?? googleSubFor(email);
      scenario.nextGrant = null;
      const code = `fake-secret-gmail-code-${randomUUID()}`;
      codes.set(code, {
        kind: "gmail",
        scenario,
        email,
        sub,
        challenge: url.searchParams.get("code_challenge"),
        redirectUri: callback.toString(),
      });
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("code", code);
      return redirect(callback);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const data = new URLSearchParams(await body(req));
      if (data.get("grant_type") === "refresh_token") {
        const scenario = [...scenarios.values()].find((candidate) =>
          [...candidate.gmailRefreshTokens.values()].includes(
            data.get("refresh_token"),
          ),
        );
        if (
          !scenario ||
          scenario.expiredGrant ||
          data.get("client_id") !== "fake-google-client" ||
          data.get("client_secret") !== "fake-google-secret"
        )
          return reply(400, { error: "invalid_grant" });
        return reply(200, {
          access_token: scenario.gmailAccessToken,
          scope: gmailScope,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      const grant = codes.get(data.get("code"));
      codes.delete(data.get("code"));
      if (
        grant?.kind === "auth" &&
        data.get("client_id") === "fake-google-client" &&
        data.get("client_secret") === "fake-google-secret" &&
        data.get("grant_type") === "authorization_code" &&
        data.get("redirect_uri") === grant.redirectUri &&
        createHash("sha256")
          .update(data.get("code_verifier") ?? "")
          .digest("base64url") === grant.challenge
      ) {
        const idToken = `fake-google-id-token-${randomUUID()}`;
        idTokens.set(idToken, { user: grant.user, nonceHash: grant.nonceHash });
        grant.scenario.exchanges.push({
          scope: "openid email",
          pkceVerified: true,
        });
        return reply(200, { id_token: idToken });
      }
      if (
        grant?.kind !== "gmail" ||
        data.get("client_id") !== "fake-google-client" ||
        data.get("client_secret") !== "fake-google-secret" ||
        data.get("grant_type") !== "authorization_code" ||
        data.get("redirect_uri") !== grant.redirectUri ||
        createHash("sha256")
          .update(data.get("code_verifier") ?? "")
          .digest("base64url") !== grant.challenge
      )
        return reply(400, { error: "invalid_grant" });
      grant.scenario.exchanges.push({
        scope: connectScope,
        pkceVerified: true,
        email: grant.email,
      });
      return reply(200, {
        access_token: grant.scenario.gmailAccessToken,
        refresh_token: gmailRefreshTokenFor(
          grant.scenario,
          grant.email,
          grant.sub,
        ),
        scope: connectScope,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idTokenFor(grant.email, grant.sub),
      });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(await body(req)).get("token");
      const scenario = [...scenarios.values()].find((candidate) =>
        [...candidate.gmailRefreshTokens.values()].includes(token),
      );
      if (!scenario) return reply(400, { error: "invalid_token" });
      if (scenario.revokeFails)
        return reply(503, { error: "provider unavailable" });
      scenario.revokedTokens.push(token);
      return reply(200, {});
    }
    if (
      url.pathname === "/gmail/v1/users/me/messages/send" &&
      req.method === "POST"
    ) {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const scenario = [...scenarios.values()].find(
        (candidate) => candidate.gmailAccessToken === token,
      );
      if (!scenario)
        return reply(401, { error: { code: 401, message: "invalid grant" } });
      if (scenario.gmailFails)
        return reply(500, { error: { code: 500, message: "backend error" } });
      const { raw } = JSON.parse(await body(req));
      if (typeof raw !== "string" || !raw)
        return reply(400, { error: { code: 400, message: "raw required" } });
      scenario.gmailMessages.push(parseMimeHeaders(raw));
      return reply(200, {
        id: `fake-gmail-message-${scenario.gmailMessages.length}`,
        threadId: "fake-gmail-thread",
        labelIds: ["SENT"],
      });
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const identity = findUser((user) => user.accessToken === bearer);
    if (url.pathname === "/auth/v1/user")
      return identity &&
        !identity.scenario.deletedUserIds.has(identity.user.id) &&
        req.headers.apikey === "fake-publishable-key"
        ? reply(200, { id: identity.user.id, email: identity.user.email })
        : reply(401, { error: "unauthorized" });
    const service =
      req.headers.apikey === "fake-secret-key" && !req.headers.authorization;
    if (
      url.pathname.startsWith("/auth/v1/admin/users/") &&
      req.method === "DELETE"
    ) {
      if (!service) return reply(401, { error: "service role required" });
      const userId = url.pathname.slice("/auth/v1/admin/users/".length);
      const target = findUser((candidate) => candidate.id === userId);
      if (!target) return reply(404, { error: "unknown user" });
      target.scenario.deletedUserIds.add(userId);
      for (const row of connectionsOf(target.scenario, userId))
        target.scenario.connections.delete(row.id);
      target.scenario.schedules = target.scenario.schedules.filter(
        (schedule) => schedule.user_id !== userId,
      );
      target.scenario.sendLogs = target.scenario.sendLogs.filter(
        (row) => row.user_id !== userId,
      );
      return reply(200, { id: userId });
    }
    if (url.pathname === "/rest/v1/schedules" && !service) {
      if (!identity || req.headers.apikey !== "fake-publishable-key")
        return reply(401, { error: "unauthorized" });
      if (req.method === "POST") {
        if (
          ["user_id", "id", "status"].some((field) =>
            url.searchParams.has(field),
          )
        )
          return reply(400, {
            error: "schedule insert filters are unsupported",
          });
      } else if (url.searchParams.get("user_id") !== `eq.${identity.user.id}`)
        return reply(403, { error: "caller owner filter required" });
      const columns = (url.searchParams.get("select") ?? "*").split(",");
      if (
        columns.some(
          (column) => column !== "*" && !scheduleColumns.includes(column),
        )
      )
        return reply(400, { error: "unknown schedule column" });
      const filters = ["id", "status"].map((field) => [
        field,
        url.searchParams.get(field),
      ]);
      if (
        filters.some(([, value]) => value !== null && !value.startsWith("eq."))
      )
        return reply(400, { error: "unsupported schedule filter" });
      const matches = (row) =>
        row.user_id === identity.user.id &&
        filters.every(
          ([field, value]) => value === null || `eq.${row[field]}` === value,
        );
      const project = (row) =>
        Object.fromEntries(
          (columns.includes("*") ? scheduleColumns : columns).map((column) => [
            column,
            row[column],
          ]),
        );
      // The composite foreign key: a sender must be one of the caller's own
      // connections. The check constraint: only a paused schedule may have
      // no sender.
      const ownsSender = (connectionId) =>
        connectionId === null ||
        connectionId === undefined ||
        connectionsOf(identity.scenario, identity.user.id).some(
          (row) => row.id === connectionId,
        );
      const senderRequired = (row) =>
        row.status !== "paused" && !row.gmail_connection_id;
      const representation = req.headers.prefer
        ?.split(",")
        .some((value) => value.trim() === "return=representation");
      if (req.method === "POST") {
        const data = JSON.parse(await body(req));
        if (!data || Array.isArray(data) || data.user_id !== identity.user.id)
          return reply(403, { error: "caller owner required" });
        if (
          Object.keys(data).some((field) => !scheduleColumns.includes(field)) ||
          ["subject", "body_text", "rrule", "timezone", "next_send_at"].some(
            (field) => typeof data[field] !== "string",
          )
        )
          return reply(400, { error: "invalid schedule row" });
        if (!ownsSender(data.gmail_connection_id))
          return reply(409, { error: "schedules_gmail_connection_id_fkey" });
        const row = {
          ...newSchedule(identity.user, "paused"),
          ...data,
          id: randomUUID(),
        };
        if (senderRequired(row))
          return reply(400, { error: "schedules_sender_required_check" });
        identity.scenario.schedules.push(row);
        return reply(201, representation ? [project(row)] : undefined);
      }
      let rows = identity.scenario.schedules.filter(matches);
      if (req.method === "GET") {
        const order = url.searchParams.get("order");
        if (order && order !== "created_at.desc,id.asc")
          return reply(400, { error: "unsupported schedule order" });
        if (order)
          rows.sort(
            (a, b) =>
              b.created_at.localeCompare(a.created_at) ||
              a.id.localeCompare(b.id),
          );
        const limit = url.searchParams.get("limit");
        if (limit !== null) {
          if (!/^[1-9]\d*$/.test(limit))
            return reply(400, { error: "invalid schedule limit" });
          rows = rows.slice(0, Number(limit));
        }
        return reply(200, rows.map(project));
      }
      if (req.method === "PATCH") {
        const data = JSON.parse(await body(req));
        if (!data || Array.isArray(data) || typeof data !== "object")
          return reply(400, { error: "invalid schedule changes" });
        if (
          Object.keys(data).some(
            (field) =>
              !scheduleColumns.includes(field) ||
              ["id", "user_id", "created_at"].includes(field),
          )
        )
          return reply(403, { error: "immutable schedule column" });
        if (!ownsSender(data.gmail_connection_id))
          return reply(409, { error: "schedules_gmail_connection_id_fkey" });
        if (rows.some((row) => senderRequired({ ...row, ...data })))
          return reply(400, { error: "schedules_sender_required_check" });
        for (const row of rows) Object.assign(row, data);
        return reply(
          representation ? 200 : 204,
          representation ? rows.map(project) : undefined,
        );
      }
      if (req.method === "DELETE") {
        identity.scenario.schedules = identity.scenario.schedules.filter(
          (row) => !matches(row),
        );
        return reply(
          representation ? 200 : 204,
          representation ? rows.map(project) : undefined,
        );
      }
      return reply(405, { error: "unsupported schedule method" });
    }
    if (
      url.pathname === "/rest/v1/gmail_connections" &&
      req.method === "GET" &&
      !service
    ) {
      if (!identity || req.headers.apikey !== "fake-publishable-key")
        return reply(401, { error: "unauthorized" });
      if (
        url.searchParams.get("user_id") !== `eq.${identity.user.id}` ||
        url.searchParams.get("select") !== publicColumns ||
        url.searchParams.get("order") !== "connected_at.asc,id.asc"
      )
        return reply(403, { error: "column grants" });
      return reply(
        200,
        connectionsOf(identity.scenario, identity.user.id)
          .sort(
            (a, b) =>
              a.connected_at.localeCompare(b.connected_at) ||
              a.id.localeCompare(b.id),
          )
          .map((row) =>
            Object.fromEntries(
              publicColumns.split(",").map((column) => [column, row[column]]),
            ),
          ),
      );
    }
    if (!service && url.pathname !== "/rest/v1/send_log")
      return reply(401, { error: "service role required" });
    if (
      url.pathname === "/rest/v1/gmail_connections" &&
      req.method === "POST"
    ) {
      // A plain insert; the database assigns the id, keeps one row per
      // address and one per Google account id per user, and caps the number
      // of accounts.
      if (url.search !== "")
        return reply(400, { error: "insert filters are unsupported" });
      const row = JSON.parse(await body(req));
      const target = findUser((user) => user.id === row.user_id);
      if (
        !target ||
        Object.keys(row).some(
          (field) => field === "id" || !connectionColumns.includes(field),
        ) ||
        typeof row.google_email !== "string" ||
        !validGoogleSub(row.google_sub) ||
        typeof row.is_workspace !== "boolean" ||
        !connectionStatuses.includes(row.status) ||
        typeof row.connected_at !== "string" ||
        typeof row.encrypted_refresh_token !== "string"
      )
        return reply(400, { error: "invalid connection row" });
      const mine = connectionsOf(target.scenario, target.user.id);
      const conflict = uniqueConflict(mine, row);
      if (conflict) return reply(409, { error: conflict });
      if (mine.length >= maxConnections)
        return reply(400, { error: "gmail_connections_cap" });
      const saved = { id: randomUUID(), google_sub: null, ...row };
      target.scenario.connections.set(saved.id, saved);
      return reply(201, undefined);
    }
    if (url.pathname === "/rest/v1/rpc/claim_test_send") {
      // Mirrors public.claim_test_send from migration 0008: count the user's
      // sends inside the window and insert one more, with nothing in between.
      if (req.method !== "POST")
        return reply(405, { error: "unsupported claim method" });
      const args = JSON.parse(await body(req));
      const owner = findUser((user) => user.id === args.p_user_id);
      if (
        !owner ||
        !Number.isInteger(args.p_limit) ||
        !Number.isInteger(args.p_window_seconds)
      )
        return reply(400, { error: "invalid claim arguments" });
      const now = Date.now();
      const floor = new Date(now - args.p_window_seconds * 1000).toISOString();
      const inWindow = owner.scenario.testSends
        .filter((row) => row.user_id === owner.user.id && row.sent_at >= floor)
        .map((row) => row.sent_at)
        .sort();
      if (inWindow.length >= args.p_limit)
        return reply(200, { allowed: false, oldest_sent_at: inWindow[0] });
      const id = randomUUID();
      owner.scenario.testSends.push({
        id,
        user_id: owner.user.id,
        sent_at: new Date(now).toISOString(),
      });
      return reply(200, { allowed: true, id });
    }
    if (url.pathname === "/rest/v1/rpc/mark_test_send_reconnect_needed") {
      // Mirrors public.mark_test_send_reconnect_needed from migration 0010:
      // the dead refresh token flips that one connection to needs_reconnect
      // and pauses the schedules sending from it. The user's other accounts
      // and their schedules are untouched. No send_log row, no reconnect email.
      if (req.method !== "POST")
        return reply(405, { error: "unsupported reconnect method" });
      const args = JSON.parse(await body(req));
      const owner = findUser((user) => user.id === args.p_user_id);
      if (!owner || typeof args.p_connection_id !== "string")
        return reply(400, { error: "invalid reconnect arguments" });
      const connection = owner.scenario.connections.get(args.p_connection_id);
      if (
        connection?.user_id === owner.user.id &&
        connection.status === "connected"
      )
        connection.status = "needs_reconnect";
      for (const schedule of owner.scenario.schedules)
        if (
          schedule.user_id === owner.user.id &&
          schedule.gmail_connection_id === args.p_connection_id &&
          (schedule.status === "active" || schedule.status === "sending")
        )
          schedule.status = "paused";
      return reply(204);
    }
    // Mirrors the column checks from migration 0012. The user, when named,
    // must exist; the summary never reads bot rows. Returns whether the row
    // was stored; when it was not, the error has been answered.
    const storeAnalyticsEvent = (row) => {
      if (
        !row ||
        Array.isArray(row) ||
        Object.keys(row).some((field) => !eventColumns.includes(field)) ||
        typeof row.event !== "string" ||
        !/^[a-z][a-z0-9_]{1,47}$/.test(row.event) ||
        !nullableUuid(row.anonymous_id) ||
        !nullableUuid(row.session_id) ||
        !nullableUuid(row.user_id) ||
        !nullableText(row.user_email, 320) ||
        !nullableText(row.path, 512) ||
        !nullableText(row.referrer_host, 255) ||
        !nullableText(row.source, 64) ||
        !nullableText(row.user_agent, 1024) ||
        !nullableText(row.accept_language, 255) ||
        !nullableText(row.region, 255) ||
        !nullableText(row.city, 255) ||
        (row.device != null &&
          !["mobile", "tablet", "desktop"].includes(row.device)) ||
        (row.country != null && !/^[A-Z]{2}$/.test(row.country)) ||
        (row.is_bot !== undefined && typeof row.is_bot !== "boolean") ||
        (row.properties !== undefined &&
          (!row.properties ||
            typeof row.properties !== "object" ||
            Array.isArray(row.properties)))
      ) {
        reply(400, { error: "invalid analytics event" });
        return false;
      }
      if (row.user_id && !findUser((user) => user.id === row.user_id)) {
        reply(409, { error: "analytics_events_user_id_fkey" });
        return false;
      }
      analyticsEvents.push({
        id: randomUUID(),
        occurred_at: new Date().toISOString(),
        is_bot: false,
        properties: {},
        ...row,
      });
      return true;
    };
    if (url.pathname === "/rest/v1/analytics_events") {
      if (req.method !== "POST" || url.search !== "")
        return reply(405, { error: "unsupported analytics method" });
      if (storeAnalyticsEvent(JSON.parse(await body(req))))
        reply(201, undefined);
      return;
    }
    if (url.pathname === "/rest/v1/rpc/record_client_event") {
      // The per-address budget itself is covered by the pgTAP tests; here
      // the arguments must be well formed and the event is always stored,
      // so the browser tests sharing 127.0.0.1 do not spend one budget.
      if (req.method !== "POST")
        return reply(405, { error: "unsupported record method" });
      const args = JSON.parse(await body(req));
      if (
        !args ||
        Object.keys(args).sort().join(",") !==
          "p_event,p_max_browsers,p_max_events,p_window_seconds" ||
        ![args.p_window_seconds, args.p_max_events, args.p_max_browsers].every(
          (value) => Number.isInteger(value) && value > 0,
        )
      )
        return reply(400, { error: "invalid record_client_event arguments" });
      if (storeAnalyticsEvent(args.p_event)) reply(200, true);
      return;
    }
    if (url.pathname === "/rest/v1/user_attribution") {
      if (req.method === "GET") {
        const filter = url.searchParams.get("user_id");
        if (
          !filter?.startsWith("eq.") ||
          url.searchParams.get("select") !== "user_id"
        )
          return reply(400, { error: "unsupported attribution query" });
        const row = userAttribution.get(filter.slice("eq.".length));
        return reply(200, row ? [{ user_id: row.user_id }] : []);
      }
      if (req.method !== "POST" || url.search !== "")
        return reply(405, { error: "unsupported attribution method" });
      const row = JSON.parse(await body(req));
      if (
        !row ||
        Array.isArray(row) ||
        Object.keys(row).some((field) => !attributionColumns.includes(field)) ||
        !UUID.test(row.user_id ?? "") ||
        !nullableUuid(row.anonymous_id) ||
        typeof row.first_source !== "string" ||
        row.first_source.length > 64 ||
        typeof row.signed_up_at !== "string"
      )
        return reply(400, { error: "invalid attribution row" });
      if (!findUser((user) => user.id === row.user_id))
        return reply(409, { error: "user_attribution_user_id_fkey" });
      if (userAttribution.has(row.user_id))
        return reply(409, { error: "user_attribution_pkey" });
      userAttribution.set(row.user_id, row);
      return reply(201, undefined);
    }
    if (url.pathname === "/rest/v1/rpc/get_analytics_summary") {
      // A shape-faithful stand-in for the summary in migration 0012.
      if (req.method !== "POST")
        return reply(405, { error: "unsupported summary method" });
      const args = JSON.parse(await body(req));
      const days = Math.max(1, Math.min(args.p_days ?? 30, 400));
      const since = Date.now() - days * 86400000;
      const rows = analyticsEvents.filter(
        (row) => !row.is_bot && Date.parse(row.occurred_at) >= since,
      );
      const person = (row) => row.anonymous_id ?? row.user_id;
      const distinct = (event) =>
        new Set(
          rows
            .filter((row) => row.event === event)
            .map(person)
            .filter(Boolean),
        ).size;
      const firstViews = new Map();
      for (const row of rows)
        if (
          row.event === "page_view" &&
          row.anonymous_id &&
          !firstViews.has(row.anonymous_id)
        )
          firstViews.set(row.anonymous_id, row);
      const signups = [...userAttribution.values()].filter(
        (row) => Date.parse(row.signed_up_at) >= since,
      );
      const sources = new Map();
      for (const row of firstViews.values()) {
        const entry = sources.get(row.source ?? "direct") ?? {
          visitors: 0,
          signups: 0,
        };
        entry.visitors += 1;
        sources.set(row.source ?? "direct", entry);
      }
      for (const row of signups) {
        const entry = sources.get(row.first_source) ?? {
          visitors: 0,
          signups: 0,
        };
        entry.signups += 1;
        sources.set(row.first_source, entry);
      }
      const tally = (values) => {
        const counts = new Map();
        for (const value of values)
          counts.set(value, (counts.get(value) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
      };
      return reply(200, {
        days,
        visitors: firstViews.size,
        signups: signups.length,
        funnel: Object.fromEntries(
          [
            "page_view",
            "signup_started",
            "signup_completed",
            "gmail_connected",
            "schedule_created",
          ].map((event) => [event, distinct(event)]),
        ),
        sources: [...sources.entries()].map(([source, entry]) => ({
          source,
          ...entry,
        })),
        landing_paths: tally(
          [...firstViews.values()].map((row) => row.path).filter(Boolean),
        )
          .slice(0, 10)
          .map(([path, visitors]) => ({ path, visitors })),
        referrers: tally(
          [
            ...new Set(
              rows
                .filter((row) => row.event === "page_view" && row.referrer_host)
                .map((row) => `${row.referrer_host}|${row.anonymous_id}`),
            ),
          ].map((key) => key.split("|")[0]),
        )
          .slice(0, 10)
          .map(([host, visitors]) => ({ host, visitors })),
        events: tally(rows.map((row) => row.event))
          .slice(0, 50)
          .map(([event, count]) => ({ event, count })),
      });
    }
    if (url.pathname === "/rest/v1/test_sends") {
      // Service-role only: the app never reads this table as the user. The
      // only direct access is giving a reservation back after a failed send.
      if (req.method !== "DELETE")
        return reply(405, { error: "unsupported test send method" });
      const owner = findUser(
        (user) => `eq.${user.id}` === url.searchParams.get("user_id"),
      );
      const idFilter = url.searchParams.get("id");
      if (!owner || !idFilter?.startsWith("eq."))
        return reply(400, { error: "invalid test send filter" });
      const id = idFilter.slice("eq.".length);
      const rows = owner.scenario.testSends;
      const index = rows.findIndex(
        (row) => row.id === id && row.user_id === owner.user.id,
      );
      if (index !== -1) rows.splice(index, 1);
      return reply(204);
    }
    const target = findUser(
      (user) => `eq.${user.id}` === url.searchParams.get("user_id"),
    );
    if (!target) return reply(400, { error: "invalid owner filter" });
    if (url.pathname === "/rest/v1/gmail_connections") {
      const idFilter = url.searchParams.get("id");
      const statusFilter = url.searchParams.get("status");
      if (
        (idFilter !== null && !idFilter.startsWith("eq.")) ||
        (statusFilter !== null && !statusFilter.startsWith("eq."))
      )
        return reply(400, { error: "unsupported connection filter" });
      let rows = connectionsOf(target.scenario, target.user.id).filter(
        (row) =>
          (idFilter === null || `eq.${row.id}` === idFilter) &&
          (statusFilter === null || `eq.${row.status}` === statusFilter),
      );
      if (req.method === "GET") {
        // The default test sender is the oldest connected account.
        const order = url.searchParams.get("order");
        if (order !== null && order !== "connected_at.asc,id.asc")
          return reply(400, { error: "unsupported connection order" });
        if (order !== null)
          rows = [...rows].sort(
            (a, b) =>
              a.connected_at.localeCompare(b.connected_at) ||
              a.id.localeCompare(b.id),
          );
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^[1-9]\d*$/.test(limit))
          return reply(400, { error: "unsupported connection limit" });
        if (limit !== null) rows = rows.slice(0, Number(limit));
        const select = url.searchParams.get("select");
        const projections = {
          encrypted_refresh_token: idFilter === null,
          "id,google_email,google_sub": idFilter === null,
          "google_email,encrypted_refresh_token": idFilter !== null,
          "id,google_email,is_workspace,status,encrypted_refresh_token": true,
        };
        if (!projections[select])
          return reply(400, { error: "unsupported connection projection" });
        return reply(
          200,
          rows.map((row) =>
            Object.fromEntries(
              select.split(",").map((column) => [column, row[column]]),
            ),
          ),
        );
      }
      if (idFilter === null)
        return reply(400, { error: "connection id filter required" });
      if (req.method === "PATCH") {
        const data = JSON.parse(await body(req));
        if (
          !data ||
          Array.isArray(data) ||
          Object.keys(data).some(
            (field) =>
              ["id", "user_id"].includes(field) ||
              !connectionColumns.includes(field),
          ) ||
          (data.status !== undefined &&
            !connectionStatuses.includes(data.status)) ||
          (data.google_sub !== undefined && !validGoogleSub(data.google_sub))
        )
          return reply(400, { error: "invalid connection changes" });
        // The unique indexes hold on update too: the new address or account
        // id must not already be on another of the user's rows.
        const others = connectionsOf(target.scenario, target.user.id).filter(
          (candidate) => !rows.includes(candidate),
        );
        for (const row of rows) {
          const conflict = uniqueConflict(others, { ...row, ...data });
          if (conflict) return reply(409, { error: conflict });
        }
        for (const row of rows) Object.assign(row, data);
        return reply(204);
      }
      if (req.method === "DELETE") {
        for (const row of rows) removeConnection(target.scenario, row.id);
        return reply(204);
      }
    }
    if (url.pathname === "/rest/v1/send_log" && req.method === "GET") {
      if (!identity || req.headers.apikey !== "fake-publishable-key") {
        return reply(401, { error: "unauthorized" });
      }
      if (url.searchParams.get("user_id") !== `eq.${identity.user.id}`)
        return reply(403, { error: "caller owner filter required" });
      const columns = (url.searchParams.get("select") ?? "").split(",");
      if (
        columns.join(",") !== "id,scheduled_for,attempted_at,status,error_code"
      )
        return reply(400, { error: "send history projection is not allowed" });
      if (url.searchParams.get("order") !== "attempted_at.desc,id.asc")
        return reply(400, { error: "send history order is required" });
      const scheduleId = url.searchParams.get("schedule_id");
      if (!scheduleId?.startsWith("eq."))
        return reply(400, { error: "schedule id filter is required" });
      return reply(
        200,
        identity.scenario.sendLogs
          .filter(
            (row) =>
              row.user_id === identity.user.id &&
              `eq.${row.schedule_id}` === scheduleId,
          )
          .sort(
            (a, b) =>
              b.attempted_at.localeCompare(a.attempted_at) ||
              a.id.localeCompare(b.id),
          )
          .map((row) =>
            Object.fromEntries(columns.map((column) => [column, row[column]])),
          ),
      );
    }
    if (url.pathname === "/rest/v1/schedules" && req.method === "PATCH") {
      // Disconnecting pauses only the schedules sending from that account.
      const data = JSON.parse(await body(req));
      const connectionFilter = url.searchParams.get("gmail_connection_id");
      if (data.status !== "paused" || !connectionFilter?.startsWith("eq."))
        return reply(400, { error: "unexpected schedule mutation" });
      for (const schedule of target.scenario.schedules)
        if (
          schedule.user_id === target.user.id &&
          `eq.${schedule.gmail_connection_id}` === connectionFilter
        ) {
          schedule.status = data.status;
          if (typeof data.updated_at === "string")
            schedule.updated_at = data.updated_at;
        }
      return reply(204);
    }
    return reply(404, { error: "unsupported fake endpoint" });
  } catch {
    return reply(400, { error: "invalid fake request" });
  }
});

// Node closes idle keep-alive sockets server-side after 5 s by default, the
// same moment the Node 22 agent behind the Playwright request fixture may reuse
// one. A request written into that close fails with ECONNRESET during scenario
// cleanup. Leave idle sockets to the clients, which close them themselves.
server.keepAliveTimeout = 0;
server.listen(Number(fakePort), "127.0.0.1");
