import "server-only";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/**
 * Consent asks for the send permission plus an ID token, so the callback can
 * learn which Google account the user actually granted (OpenID Connect Core
 * 3.1.3.7) instead of assuming it was the sign-in account.
 */
export const GMAIL_CONNECT_SCOPE = `openid email ${GMAIL_SEND_SCOPE}`;
const grantedScopes = new Set([
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
  GMAIL_SEND_SCOPE,
]);
const issuers = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GrantedAccount {
  refreshToken: string;
  /** Google's stable id for the account (the `sub` claim). It survives an address change. */
  sub: string;
  /** The verified address of the account that granted gmail.send. */
  email: string;
  isWorkspace: boolean;
}

export interface GoogleProvider {
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    challenge: string;
    /**
     * Pre-selects this account when reconnecting it. Omitted when adding
     * another account, which asks Google to show the account chooser.
     */
    email?: string;
  }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<GrantedAccount>;
  revoke(refreshToken: string): Promise<void>;
  /** Exchange a stored refresh token for a short-lived access token. */
  refreshAccessToken(refreshToken: string): Promise<string>;
  /** Send a prebuilt RFC 2822 message (base64url `raw`) as the signed-in Gmail user. */
  sendMessage(accessToken: string, raw: string): Promise<void>;
}

/** Google refused the refresh grant; `invalid_grant` means the user must reconnect. */
export class GoogleTokenError extends Error {
  constructor(readonly code: string) {
    super(`Google token request failed: ${code}`);
  }
}

/** Gmail rejected or failed the send; the status is the only detail kept. */
export class GmailSendError extends Error {
  constructor(readonly status: number) {
    super(`Gmail send failed with status ${status}`);
  }
}

// Browser tests may use a local provider; deployed builds always use Google.
function loopbackOrigin(value: string, message: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.origin !== value
  )
    throw new Error(message);
  return endpoint.origin;
}

export function isWorkspaceAddress(email: string): boolean {
  return !["gmail.com", "googlemail.com"].includes(
    email.slice(email.lastIndexOf("@") + 1).toLowerCase(),
  );
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/**
 * Reads the account out of an ID token returned by the token endpoint. The
 * token arrived over TLS directly from Google, so the issuer, audience,
 * expiry and verified-email claims are checked instead of the signature.
 */
export function grantedAccountFromIdToken(
  idToken: unknown,
  clientId: string,
  now: number,
): { sub: string; email: string; isWorkspace: boolean } | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let claims: unknown;
  try {
    claims = decodeSegment(parts[1]);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!claims || typeof claims !== "object") return null;
  const { iss, aud, exp, sub, email, email_verified } = claims as Record<
    string,
    unknown
  >;
  if (typeof iss !== "string" || !issuers.has(iss)) return null;
  if (aud !== clientId) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp * 1000 <= now)
    return null;
  if (email_verified !== true) return null;
  // The subject is required (OpenID Connect Core 2) and at most 255 ASCII
  // characters. A token without one cannot name the account.
  if (typeof sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(sub)) return null;
  if (
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  )
    return null;
  return { sub, email, isWorkspace: isWorkspaceAddress(email) };
}

export function createGoogleProvider(config: {
  clientId: string;
  clientSecret: string;
  testOAuthOrigin?: string;
  testGmailOrigin?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): GoogleProvider {
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;
  let authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  let tokenOrigin = "https://oauth2.googleapis.com";
  let gmailOrigin = "https://gmail.googleapis.com";
  if (config.testOAuthOrigin && process.env.NODE_ENV !== "production") {
    const origin = loopbackOrigin(
      config.testOAuthOrigin,
      "Test OAuth endpoint must be a loopback origin",
    );
    authorizationEndpoint = `${origin}/o/oauth2/v2/auth`;
    tokenOrigin = origin;
  }
  if (config.testGmailOrigin && process.env.NODE_ENV !== "production") {
    gmailOrigin = loopbackOrigin(
      config.testGmailOrigin,
      "Test Gmail endpoint must be a loopback origin",
    );
  }
  return {
    authorizationUrl({ redirectUri, state, challenge, email }) {
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GMAIL_CONNECT_SCOPE,
        access_type: "offline",
        // A refresh token needs consent every time. Without a hinted account,
        // the chooser lets the user pick which account to add.
        prompt: email ? "consent" : "consent select_account",
        include_granted_scopes: "false",
        ...(email ? { login_hint: email } : {}),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },
    async exchangeCode(code, redirectUri, verifier) {
      const response = await fetcher(`${tokenOrigin}/token`, {
        method: "POST",
        body: new URLSearchParams({
          code,
          code_verifier: verifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        cache: "no-store",
      });
      const body = await response.json();
      const scopes =
        typeof body.scope === "string" ? body.scope.split(/\s+/) : [];
      const account = grantedAccountFromIdToken(
        body.id_token,
        config.clientId,
        now(),
      );
      if (
        !response.ok ||
        typeof body.refresh_token !== "string" ||
        !body.refresh_token ||
        !scopes.includes(GMAIL_SEND_SCOPE) ||
        !scopes.every((scope: string) => grantedScopes.has(scope)) ||
        !account
      ) {
        throw new Error("Gmail permission could not be granted");
      }
      return { refreshToken: body.refresh_token, ...account };
    },
    async revoke(refreshToken) {
      const response = await fetcher(`${tokenOrigin}/revoke`, {
        method: "POST",
        body: new URLSearchParams({ token: refreshToken }),
        cache: "no-store",
      });
      if (response.ok) return;
      if (response.status === 400) {
        const body = await response.json();
        if (body.error === "invalid_token") return;
      }
      throw new Error("Gmail revocation failed");
    },
    async refreshAccessToken(refreshToken) {
      const response = await fetcher(`${tokenOrigin}/token`, {
        method: "POST",
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new GoogleTokenError(
          body?.error === "invalid_grant" ? "invalid_grant" : "token_failed",
        );
      }
      if (typeof body.access_token !== "string" || !body.access_token)
        throw new GoogleTokenError("token_failed");
      return body.access_token;
    },
    async sendMessage(accessToken, raw) {
      const response = await fetcher(
        `${gmailOrigin}/gmail/v1/users/me/messages/send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ raw }),
          cache: "no-store",
        },
      );
      if (!response.ok) throw new GmailSendError(response.status);
    },
  };
}
