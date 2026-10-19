import "server-only";

export interface GoogleSignIn {
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    challenge: string;
    nonceHash: string;
  }): string;
  exchangeCode(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<string>;
}

export function createGoogleSignIn(config: {
  clientId: string;
  clientSecret: string;
  testOAuthOrigin?: string;
  fetcher?: typeof fetch;
}): GoogleSignIn {
  const fetcher = config.fetcher ?? fetch;
  let tokenEndpoint = "https://oauth2.googleapis.com/token";
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
    tokenEndpoint = `${endpoint.origin}/token`;
  }
  return {
    authorizationUrl({ redirectUri, state, challenge, nonceHash }) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: nonceHash,
      }).toString();
      return url.toString();
    },
    async exchangeCode(code, redirectUri, verifier) {
      const response = await fetcher(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
      if (!response.ok || typeof body.id_token !== "string" || !body.id_token)
        throw new Error("Google sign-in failed");
      return body.id_token;
    },
  };
}
