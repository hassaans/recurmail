import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

// Local fake OAuth/Supabase boundary, never loaded by the application.
const origin = "http://127.0.0.1:3101";
const appOrigin = "http://127.0.0.1:3100";
const gmailScope = "https://www.googleapis.com/auth/gmail.send";
const publicColumns = "user_id,google_email,is_workspace,status,connected_at";
const scenarios = new Map();
const codes = new Map();

function newUser(domain = "gmail.com") {
  const id = randomUUID();
  return {
    id,
    email: `${id}@${domain}`,
    accessToken: `fake-secret-session-access-${id}`,
    refreshToken: `fake-secret-session-refresh-${id}`,
  };
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
      { id: randomUUID(), user_id: owner.id, status: "active" },
      { id: randomUUID(), user_id: owner.id, status: "paused" },
      { id: randomUUID(), user_id: connected.id, status: "active" },
    ],
    revokedTokens: [],
    exchanges: [],
  };
  scenarios.set(scenario.id, scenario);
  return scenario;
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

createServer(async (req, res) => {
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
      const { connections, schedules, revokedTokens, exchanges, ...scenario } =
        newScenario();
      return reply(201, scenario);
    }
    if (url.pathname.startsWith("/__test/scenarios/")) {
      const id = url.pathname.slice("/__test/scenarios/".length);
      const scenario = scenarios.get(id);
      if (!scenario) return reply(404, { error: "unknown test scenario" });
      if (req.method === "DELETE") {
        scenarios.delete(id);
        for (const [code, grant] of codes)
          if (grant.scenario.id === id) codes.delete(code);
        return reply(200, { deleted: true });
      }
      return reply(200, {
        connections: [...scenario.connections.values()],
        schedules: scenario.schedules,
        revokedTokens: scenario.revokedTokens,
        exchanges: scenario.exchanges,
      });
    }
    if (url.pathname === "/auth/v1/authorize") {
      const id = req.headers.cookie
        ?.split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("fake_scenario="))
        ?.slice("fake_scenario=".length);
      const scenario = scenarios.get(id);
      const callback = new URL(url.searchParams.get("redirect_to"));
      if (
        !scenario ||
        url.searchParams.get("provider") !== "google" ||
        url.searchParams.get("scopes") !== "openid email profile" ||
        url.searchParams.get("code_challenge_method") !== "s256" ||
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
      });
      callback.searchParams.set("code", code);
      return redirect(callback);
    }
    if (url.pathname === "/auth/v1/token" && req.method === "POST") {
      if (req.headers.apikey !== "fake-anon-key")
        return reply(401, { error: "invalid API key" });
      const data = JSON.parse(await body(req));
      let user;
      if (url.searchParams.get("grant_type") === "pkce") {
        const grant = codes.get(data.auth_code);
        codes.delete(data.auth_code);
        if (
          grant?.kind !== "auth" ||
          createHash("sha256")
            .update(data.code_verifier)
            .digest("base64url") !== grant.challenge
        )
          return reply(400, { error: "invalid_grant" });
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
      const grant = codes.get(data.get("code"));
      codes.delete(data.get("code"));
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
      scenario.revokedTokens.push(token);
      return reply(200, {});
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const identity = findUser((user) => user.accessToken === bearer);
    if (url.pathname === "/auth/v1/user")
      return identity && req.headers.apikey === "fake-anon-key"
        ? reply(200, { id: identity.user.id, email: identity.user.email })
        : reply(401, { error: "unauthorized" });
    const service =
      bearer === "fake-service-key" &&
      req.headers.apikey === "fake-service-key";
    if (
      url.pathname === "/rest/v1/gmail_connections" &&
      req.method === "GET" &&
      !service
    ) {
      if (!identity || req.headers.apikey !== "fake-anon-key")
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
    if (!service) return reply(401, { error: "service role required" });
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
    const target = findUser(
      (user) => `eq.${user.id}` === url.searchParams.get("user_id"),
    );
    if (!target) return reply(400, { error: "invalid owner filter" });
    if (url.pathname === "/rest/v1/gmail_connections") {
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
}).listen(3101, "127.0.0.1");
