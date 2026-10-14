import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { decryptRefreshToken, encryptRefreshToken } from "./crypto";
import { cookieHeader, readCookie, redirectResponse } from "./http";
import type { Session, SupabaseAuth } from "./supabase-auth";

const stateCookie = "rm_auth_state";
export const SESSION_COOKIE = "rm_session";

export function sessionCookie(
  session: Session,
  key: string,
  origin: string,
): string {
  return cookieHeader(
    SESSION_COOKIE,
    encryptRefreshToken(JSON.stringify(session), key, "session"),
    origin,
    30 * 24 * 60 * 60,
  );
}

export function readSession(request: Request, key: string): Session | null {
  const encrypted = readCookie(request, SESSION_COOKIE);
  if (!encrypted) return null;
  try {
    const data = JSON.parse(decryptRefreshToken(encrypted, key, "session"));
    if (
      typeof data.accessToken !== "string" ||
      !data.accessToken ||
      typeof data.refreshToken !== "string" ||
      !data.refreshToken ||
      !Number.isFinite(data.expiresAt)
    )
      return null;
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
    };
  } catch {
    console.error("[ERROR] auth_session_failed");
    return null;
  }
}

export function createAuthHandlers(config: {
  origin: string;
  key: string;
  auth: SupabaseAuth;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  function failure() {
    return redirectResponse(config.origin, "/dashboard?auth=failed");
  }
  function clearState(response: Response) {
    response.headers.append(
      "Set-Cookie",
      cookieHeader(stateCookie, "", config.origin, 0),
    );
    return response;
  }
  return {
    async signin(): Promise<Response> {
      try {
        const state = randomBytes(32).toString("base64url");
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const envelope = encryptRefreshToken(
          JSON.stringify({ state, verifier, expiresAt: now() + 600_000 }),
          config.key,
          "auth-state",
        );
        const response = redirectResponse(
          config.origin,
          config.auth.authorizationUrl(
            `${config.origin}/auth/callback?state=${state}`,
            challenge,
          ),
        );
        response.headers.append(
          "Set-Cookie",
          cookieHeader(stateCookie, envelope, config.origin, 600),
        );
        return response;
      } catch {
        console.error("[ERROR] auth_signin_failed");
        return failure();
      }
    },
    async callback(request: Request): Promise<Response> {
      try {
        const envelope = readCookie(request, stateCookie);
        if (!envelope) return clearState(failure());
        const saved = JSON.parse(
          decryptRefreshToken(envelope, config.key, "auth-state"),
        );
        const params = new URL(request.url).searchParams;
        const code = params.get("code");
        if (
          !saved.state ||
          !saved.verifier ||
          saved.state !== params.get("state") ||
          !Number.isFinite(saved.expiresAt) ||
          saved.expiresAt <= now() ||
          params.get("error") ||
          !code
        )
          return clearState(failure());
        const session = await config.auth.exchangeCode(code, saved.verifier);
        if (!(await config.auth.getUser(session.accessToken)))
          return clearState(failure());
        const response = clearState(
          redirectResponse(config.origin, "/dashboard"),
        );
        response.headers.append(
          "Set-Cookie",
          sessionCookie(session, config.key, config.origin),
        );
        return response;
      } catch {
        console.error("[ERROR] auth_callback_failed");
        return clearState(failure());
      }
    },
    async refresh(request: Request): Promise<Response> {
      try {
        const session = readSession(request, config.key);
        if (!session) throw new Error("Sign-in required");
        const refreshed = await config.auth.refresh(session.refreshToken);
        if (!(await config.auth.getUser(refreshed.accessToken)))
          throw new Error("Sign-in required");
        const response = redirectResponse(config.origin, "/dashboard");
        response.headers.append(
          "Set-Cookie",
          sessionCookie(refreshed, config.key, config.origin),
        );
        return response;
      } catch {
        console.error("[ERROR] auth_refresh_failed");
        const response = failure();
        response.headers.append(
          "Set-Cookie",
          cookieHeader(SESSION_COOKIE, "", config.origin, 0),
        );
        return response;
      }
    },
  };
}
