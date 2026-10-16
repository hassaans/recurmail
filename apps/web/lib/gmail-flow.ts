import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ServerAnalytics } from "./analytics-server";
import {
  ConnectionAddressConflictError,
  ConnectionLimitError,
  type ConnectionStore,
  isConnectionId,
  MAX_GMAIL_CONNECTIONS,
} from "./connections";
import { decryptRefreshToken, encryptRefreshToken } from "./crypto";
import type { GoogleProvider } from "./google";
import { cookieHeader, readCookie, redirectResponse, sameOrigin } from "./http";
import type { SignedInUser } from "./supabase-auth";

export interface Identity {
  user: SignedInUser;
  accessToken: string;
}
export type Authenticate = (request: Request) => Promise<Identity | null>;
const stateCookie = "rm_gmail_state";
const stateLifetime = 600_000;

export function createGmailHandlers(config: {
  origin: string;
  key: string;
  authenticate: Authenticate;
  store: ConnectionStore;
  google: GoogleProvider;
  analytics?: ServerAnalytics;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  const callbackUri = `${config.origin}/api/gmail/callback`;
  const track: ServerAnalytics["track"] = async (request, event, input) =>
    config.analytics?.track(request, event, input);
  const result = (status: string, email?: string) =>
    redirectResponse(
      config.origin,
      `/dashboard?gmail=${status}${
        email ? `&email=${encodeURIComponent(email)}` : ""
      }`,
    );
  const signIn = () =>
    redirectResponse(config.origin, "/dashboard?auth=required");
  const forbidden = () =>
    new Response("Request origin is not allowed", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  function clearState(response: Response) {
    response.headers.append(
      "Set-Cookie",
      cookieHeader(stateCookie, "", config.origin, 0),
    );
    return response;
  }
  // The connection to reconnect, if the form named one. Anything else means
  // "add another account".
  async function requestedConnectionId(
    request: Request,
  ): Promise<string | null> {
    if (
      !request.headers
        .get("content-type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return null;
    const form = await request.formData();
    const id = form.get("id");
    return typeof id === "string" && isConnectionId(id) ? id : null;
  }
  return {
    async connect(request: Request): Promise<Response> {
      if (!sameOrigin(request, config.origin)) return forbidden();
      try {
        const identity = await config.authenticate(request);
        if (!identity) return signIn();
        const connectionId = await requestedConnectionId(request);
        const connections = await config.store.list(
          identity.user.id,
          identity.accessToken,
        );
        const reconnecting = connectionId
          ? connections.find((connection) => connection.id === connectionId)
          : undefined;
        if (!reconnecting && connections.length >= MAX_GMAIL_CONNECTIONS)
          return result("limit");
        await track(request, "gmail_connect_started", {
          userId: identity.user.id,
          userEmail: identity.user.email,
          properties: {
            reconnect: Boolean(reconnecting),
            account_count: connections.length,
          },
        });
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const envelope = encryptRefreshToken(
          JSON.stringify({
            state,
            verifier,
            hint: reconnecting?.google_email ?? null,
            expiresAt: now() + stateLifetime,
          }),
          config.key,
          identity.user.id,
        );
        const response = redirectResponse(
          config.origin,
          config.google.authorizationUrl({
            redirectUri: callbackUri,
            state,
            ...(reconnecting ? { email: reconnecting.google_email } : {}),
            challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
          }),
        );
        response.headers.append(
          "Set-Cookie",
          cookieHeader(
            stateCookie,
            envelope,
            config.origin,
            stateLifetime / 1000,
          ),
        );
        return response;
      } catch {
        console.error("[ERROR] gmail_connect_failed");
        return result("failed");
      }
    },
    async callback(request: Request): Promise<Response> {
      let token: string | undefined;
      let email: string | undefined;
      try {
        const identity = await config.authenticate(request);
        if (!identity) return clearState(signIn());
        const envelope = readCookie(request, stateCookie);
        if (!envelope) return clearState(result("failed"));
        // The envelope is bound to the signed-in user id through the cipher's
        // associated data, so another user's cookie cannot complete this flow.
        const saved = JSON.parse(
          decryptRefreshToken(envelope, config.key, identity.user.id),
        );
        const params = new URL(request.url).searchParams;
        if (
          !saved.state ||
          typeof saved.verifier !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) ||
          saved.state !== params.get("state") ||
          !Number.isFinite(saved.expiresAt) ||
          saved.expiresAt <= now()
        )
          return clearState(result("failed"));
        if (params.get("error")) {
          const denied = params.get("error") === "access_denied";
          await track(
            request,
            denied ? "gmail_connect_denied" : "gmail_connect_failed",
            {
              userId: identity.user.id,
              userEmail: identity.user.email,
              properties: { reason: "google" },
            },
          );
          return clearState(result(denied ? "denied" : "failed"));
        }
        const code = params.get("code");
        if (!code) return clearState(result("failed"));
        const granted = await config.google.exchangeCode(
          code,
          callbackUri,
          saved.verifier,
        );
        token = granted.refreshToken;
        email = granted.email;
        // The account comes from the ID token Google returned with the grant,
        // so a user who picked a different account than the one hinted gets
        // that account connected, and the notice names it. Its stable id keys
        // the row, so the same account under a new address keeps its row.
        await config.store.save({
          user_id: identity.user.id,
          google_sub: granted.sub,
          google_email: granted.email,
          is_workspace: granted.isWorkspace,
          encrypted_refresh_token: encryptRefreshToken(
            token,
            config.key,
            identity.user.id,
          ),
          status: "connected",
          connected_at: new Date(now()).toISOString(),
        });
        await track(request, "gmail_connected", {
          userId: identity.user.id,
          userEmail: identity.user.email,
          properties: {
            workspace: granted.isWorkspace,
            reconnect: typeof saved.hint === "string",
          },
        });
        return clearState(result("connected", granted.email));
      } catch (error) {
        // The account cap and an address already held by another of the
        // user's Google accounts are outcomes the user acts on, not faults.
        let status = "failed";
        if (error instanceof ConnectionLimitError) status = "limit";
        else if (error instanceof ConnectionAddressConflictError)
          status = "address_in_use";
        if (status === "failed") console.error("[ERROR] gmail_callback_failed");
        await track(request, "gmail_connect_failed", {
          properties: { reason: status },
        });
        // A grant that could not be persisted must not remain active at Google.
        if (token) {
          try {
            await config.google.revoke(token);
          } catch {
            console.error("[ERROR] gmail_compensating_revocation_failed");
          }
        }
        return clearState(
          result(status, status === "address_in_use" ? email : undefined),
        );
      }
    },
    async disconnect(request: Request): Promise<Response> {
      if (!sameOrigin(request, config.origin)) return forbidden();
      try {
        const identity = await config.authenticate(request);
        if (!identity) return signIn();
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!isConnectionId(id)) return result("disconnect_failed");
        // Pause first so a revocation outage cannot leave future sends active.
        await config.store.pauseSchedules(identity.user.id, id);
        const credential = await config.store.readCredential(
          identity.user.id,
          id,
        );
        // Already gone: a repeated submit has nothing left to revoke.
        if (!credential) return result("disconnected");
        await config.google.revoke(
          decryptRefreshToken(
            credential.encrypted_refresh_token,
            config.key,
            identity.user.id,
          ),
        );
        await config.store.delete(identity.user.id, id);
        await track(request, "gmail_disconnected", {
          userId: identity.user.id,
          userEmail: identity.user.email,
        });
        return clearState(result("disconnected", credential.google_email));
      } catch {
        console.error("[ERROR] gmail_disconnect_failed");
        // Retain the encrypted credential until revocation succeeds, allowing retry.
        return result("disconnect_failed");
      }
    },
  };
}
