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
const publicColumns = "user_id,google_email,is_workspace,status,connected_at";
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
  "created_at",
  "updated_at",
];
const scenarios = new Map();
const codes = new Map();
const idTokens = new Map();

function newUser(domain = "gmail.com") {
  const id = randomUUID();
  return {
    id,
    email: `${id}@${domain}`,
    accessToken: `fake-secret-session-access-${id}`,
    refreshToken: `fake-secret-session-refresh-${id}`,
  };
}

function newSchedule(user, status = "active") {
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
    created_at: now,
    updated_at: now,
  };
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

function newScenario() {
  const owner = newUser();
  const connected = newUser();
  const reconnect = newUser("workspace.test");
  const scenario = {
    id: randomUUID(),
    owner,
    connected,
    reconnect,
    foreignUserId: connected.id,
    gmailAccessToken: `fake-secret-gmail-access-${owner.id}`,
    gmailRefreshToken: `fake-secret-gmail-refresh-${owner.id}`,
    connections: new Map(
      [connected, reconnect].map((user) => [
        user.id,
        {
          id: randomUUID(),
          user_id: user.id,
          google_email: user.email,
          is_workspace: user === reconnect,
          status: user === reconnect ? "needs_reconnect" : "connected",
          connected_at: "2026-10-14",
          encrypted_refresh_token: "fixture-ciphertext",
        },
      ]),
    ),
    schedules: [
      newSchedule(owner),
      newSchedule(owner, "paused"),
      newSchedule(connected),
      newSchedule(reconnect),
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
  };
  scenarios.set(scenario.id, scenario);
  return scenario;
}

/** Give the already-connected personal account a real, decryptable refresh token. */
function connectForTestSend(scenario) {
  const connection = scenario.connections.get(scenario.connected.id);
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
        scenario.connections.set(scenario.owner.id, {
          user_id: scenario.owner.id,
          google_email: scenario.owner.email,
          is_workspace: false,
          status: "connected",
          connected_at: "2026-10-14",
          encrypted_refresh_token: encryptedToken(
            scenario.gmailRefreshToken,
            scenario.owner.id,
          ),
        });
        return reply(200, { user_id: scenario.owner.id });
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
        const day = 86400000;
        const started = new Date(Date.now() - 3 * day);
        started.setUTCHours(9, 0, 0, 0);
        const stamp = (date) =>
          date.toISOString().replace(/[-:]/g, "").replace(".000", "");
        const lastSend = new Date(started.getTime() + 2 * day);
        const counted = {
          ...newSchedule(user, "paused"),
          subject: "Quarterly reminder",
          rrule: `DTSTART:${stamp(started)}\nRRULE:FREQ=DAILY;COUNT=3`,
          next_send_at: lastSend.toISOString(),
        };
        const endDay = new Date(Date.now() - day).toISOString().slice(0, 10);
        const dated = {
          ...newSchedule(user, "paused"),
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
      url.searchParams.get("scope") === "openid email profile"
    ) {
      const id = req.headers.cookie
        ?.split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("fake_scenario="))
        ?.slice("fake_scenario=".length);
      const scenario = scenarios.get(id);
      const callback = new URL(url.searchParams.get("redirect_uri"));
      if (
        !scenario ||
        url.searchParams.get("client_id") !== "fake-google-client" ||
        url.searchParams.get("scope") !== "openid email profile" ||
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
      const identity = findUser(
        (user) => user.email === url.searchParams.get("login_hint"),
      );
      const callback = new URL(url.searchParams.get("redirect_uri"));
      if (
        !identity ||
        url.searchParams.get("scope") !== gmailScope ||
        url.searchParams.get("client_id") !== "fake-google-client" ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("access_type") !== "offline" ||
        url.searchParams.get("prompt") !== "consent" ||
        url.searchParams.get("include_granted_scopes") !== "false" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        !url.searchParams.get("code_challenge") ||
        url.searchParams.has("code_verifier") ||
        !url.searchParams.get("state") ||
        callback.origin !== appOrigin ||
        callback.pathname !== "/api/gmail/callback"
      )
        return reply(400, { error: "unexpected Gmail authorization" });
      const code = `fake-secret-gmail-code-${randomUUID()}`;
      codes.set(code, {
        kind: "gmail",
        ...identity,
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
        const scenario = [...scenarios.values()].find(
          (candidate) =>
            candidate.gmailRefreshToken === data.get("refresh_token"),
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
          scope: "openid email profile",
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
      grant.scenario.exchanges.push({ scope: gmailScope, pkceVerified: true });
      return reply(200, {
        access_token: grant.scenario.gmailAccessToken,
        refresh_token: grant.scenario.gmailRefreshToken,
        scope: gmailScope,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const token = new URLSearchParams(await body(req)).get("token");
      const scenario = [...scenarios.values()].find(
        (candidate) => candidate.gmailRefreshToken === token,
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
      target.scenario.connections.delete(userId);
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
        const row = {
          ...newSchedule(identity.user, "paused"),
          ...data,
          id: randomUUID(),
        };
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
        url.searchParams.get("select") !== publicColumns
      )
        return reply(403, { error: "column grants" });
      const row = identity.scenario.connections.get(identity.user.id);
      return reply(
        200,
        row
          ? [
              Object.fromEntries(
                publicColumns.split(",").map((column) => [column, row[column]]),
              ),
            ]
          : [],
      );
    }
    if (!service && url.pathname !== "/rest/v1/send_log")
      return reply(401, { error: "service role required" });
    if (
      url.pathname === "/rest/v1/gmail_connections" &&
      req.method === "POST"
    ) {
      const row = JSON.parse(await body(req));
      const target = findUser((user) => user.id === row.user_id);
      if (!target || url.searchParams.get("on_conflict") !== "user_id")
        return reply(400, { error: "invalid owner" });
      target.scenario.connections.set(row.user_id, row);
      return reply(204);
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
      // Mirrors public.mark_test_send_reconnect_needed from migration 0009:
      // the dead refresh token flips the connection to needs_reconnect and
      // pauses the user's active schedules. No send_log row, no reconnect email.
      if (req.method !== "POST")
        return reply(405, { error: "unsupported reconnect method" });
      const args = JSON.parse(await body(req));
      const owner = findUser((user) => user.id === args.p_user_id);
      if (!owner) return reply(400, { error: "invalid reconnect arguments" });
      const connection = owner.scenario.connections.get(owner.user.id);
      if (connection?.status === "connected")
        connection.status = "needs_reconnect";
      for (const schedule of owner.scenario.schedules)
        if (
          schedule.user_id === owner.user.id &&
          (schedule.status === "active" || schedule.status === "sending")
        )
          schedule.status = "paused";
      return reply(204);
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
      if (
        req.method === "GET" &&
        url.searchParams.get("select") ===
          "id,google_email,is_workspace,status,encrypted_refresh_token"
      ) {
        const idFilter = url.searchParams.get("id");
        if (idFilter !== null && !idFilter.startsWith("eq."))
          return reply(400, { error: "unsupported connection filter" });
        const row = target.scenario.connections.get(target.user.id);
        const rows =
          row && (idFilter === null || `eq.${row.id}` === idFilter)
            ? [row]
            : [];
        return reply(
          200,
          rows.map((connection) => ({
            id: connection.id,
            google_email: connection.google_email,
            is_workspace: connection.is_workspace,
            status: connection.status,
            encrypted_refresh_token: connection.encrypted_refresh_token,
          })),
        );
      }
      if (
        req.method === "GET" &&
        url.searchParams.get("select") === "encrypted_refresh_token"
      ) {
        const row = target.scenario.connections.get(target.user.id);
        return reply(
          200,
          row ? [{ encrypted_refresh_token: row.encrypted_refresh_token }] : [],
        );
      }
      if (req.method === "DELETE") {
        target.scenario.connections.delete(target.user.id);
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
      const data = JSON.parse(await body(req));
      if (data.status !== "paused")
        return reply(400, { error: "unexpected schedule mutation" });
      for (const schedule of target.scenario.schedules)
        if (schedule.user_id === target.user.id) schedule.status = data.status;
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
