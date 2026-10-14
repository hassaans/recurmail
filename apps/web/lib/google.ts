import "server-only";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export interface GoogleProvider {
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    email: string;
    challenge: string;
  }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<string>;
  revoke(refreshToken: string): Promise<void>;
}

export function createGoogleProvider(config: {
  clientId: string;
  clientSecret: string;
  testOAuthOrigin?: string;
  fetcher?: typeof fetch;
}): GoogleProvider {
  const fetcher = config.fetcher ?? fetch;
  let authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  let tokenOrigin = "https://oauth2.googleapis.com";
  // Browser tests may use a local provider; deployed builds always use Google.
  if (config.testOAuthOrigin && process.env.NODE_ENV !== "production") {
    let endpoint: URL;
    try {
      endpoint = new URL(config.testOAuthOrigin);
    } catch {
      throw new Error("Test OAuth endpoint must be a loopback origin");
    }
    if (
      endpoint.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.origin !== config.testOAuthOrigin
    )
      throw new Error("Test OAuth endpoint must be a loopback origin");
    authorizationEndpoint = `${endpoint.origin}/o/oauth2/v2/auth`;
    tokenOrigin = endpoint.origin;
  }
  return {
    authorizationUrl({ redirectUri, state, email, challenge }) {
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GMAIL_SEND_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
        login_hint: email,
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
      if (
        !response.ok ||
        typeof body.refresh_token !== "string" ||
        !body.refresh_token ||
        body.scope !== GMAIL_SEND_SCOPE
      ) {
        throw new Error("Gmail permission could not be granted");
      }
      return body.refresh_token;
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
  };
}
