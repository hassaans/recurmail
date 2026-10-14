import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { ConnectionStore } from "./connections";
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
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  const callbackUri = `${config.origin}/api/gmail/callback`;
  const result = (status: string) =>
    redirectResponse(config.origin, `/dashboard?gmail=${status}`);
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
  return {
    async connect(request: Request): Promise<Response> {
      if (!sameOrigin(request, config.origin)) return forbidden();
      try {
        const identity = await config.authenticate(request);
        if (!identity) return signIn();
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const envelope = encryptRefreshToken(
          JSON.stringify({
            state,
            verifier,
            email: identity.user.email,
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
            email: identity.user.email,
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
      try {
        const identity = await config.authenticate(request);
        if (!identity) return clearState(signIn());
        const envelope = readCookie(request, stateCookie);
        if (!envelope) return clearState(result("failed"));
        const saved = JSON.parse(
          decryptRefreshToken(envelope, config.key, identity.user.id),
        );
        const params = new URL(request.url).searchParams;
        if (
          !saved.state ||
          typeof saved.verifier !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier) ||
          saved.state !== params.get("state") ||
          saved.email !== identity.user.email ||
          !Number.isFinite(saved.expiresAt) ||
          saved.expiresAt <= now()
        )
          return clearState(result("failed"));
        if (params.get("error"))
          return clearState(
            result(
              params.get("error") === "access_denied" ? "denied" : "failed",
            ),
          );
        const code = params.get("code");
        if (!code) return clearState(result("failed"));
        token = await config.google.exchangeCode(
          code,
          callbackUri,
          saved.verifier,
        );
        await config.store.save({
          user_id: identity.user.id,
          google_email: identity.user.email,
          is_workspace: !["gmail.com", "googlemail.com"].includes(
            identity.user.email
              .slice(identity.user.email.lastIndexOf("@") + 1)
              .toLowerCase(),
          ),
          encrypted_refresh_token: encryptRefreshToken(
            token,
            config.key,
            identity.user.id,
          ),
          status: "connected",
          connected_at: new Date(now()).toISOString(),
        });
        return clearState(result("connected"));
      } catch {
        console.error("[ERROR] gmail_callback_failed");
        // A grant that could not be persisted must not remain active at Google.
        if (token) {
          try {
            await config.google.revoke(token);
          } catch {
            console.error("[ERROR] gmail_compensating_revocation_failed");
          }
        }
        return clearState(result("failed"));
      }
    },
    async disconnect(request: Request): Promise<Response> {
      if (!sameOrigin(request, config.origin)) return forbidden();
      try {
        const identity = await config.authenticate(request);
        if (!identity) return signIn();
        // Pause first so a revocation outage cannot leave future sends active.
        await config.store.pauseSchedules(identity.user.id);
        const encrypted = await config.store.readEncryptedToken(
          identity.user.id,
        );
        if (encrypted)
          await config.google.revoke(
            decryptRefreshToken(encrypted, config.key, identity.user.id),
          );
        await config.store.delete(identity.user.id);
        return clearState(result("disconnected"));
      } catch {
        console.error("[ERROR] gmail_disconnect_failed");
        // Retain the encrypted credential until revocation succeeds, allowing retry.
        return result("disconnect_failed");
      }
    },
  };
}
