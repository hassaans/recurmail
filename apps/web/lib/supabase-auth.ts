import "server-only";

export interface SignedInUser {
  id: string;
  email: string;
}
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface SupabaseAdmin {
  deleteUser(userId: string): Promise<void>;
}

export function createSupabaseAdmin(config: {
  url: string;
  serviceKey: string;
  fetcher?: typeof fetch;
}): SupabaseAdmin {
  const fetcher = config.fetcher ?? fetch;
  return {
    async deleteUser(userId) {
      const response = await fetcher(
        config.url + "/auth/v1/admin/users/" + encodeURIComponent(userId),
        {
          method: "DELETE",
          headers: {
            apikey: config.serviceKey,
            Authorization: "Bearer " + config.serviceKey,
          },
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error("Account deletion failed");
    },
  };
}

export interface SupabaseAuth {
  authorizationUrl(redirectUri: string, challenge: string): string;
  exchangeCode(code: string, verifier: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  getUser(accessToken: string): Promise<SignedInUser | null>;
}

export function createSupabaseAuth(config: {
  url: string;
  anonKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): SupabaseAuth {
  const fetcher = config.fetcher ?? fetch;
  const now = config.now ?? Date.now;
  async function token(grant: string, body: object): Promise<Session> {
    const response = await fetcher(
      `${config.url}/auth/v1/token?grant_type=${grant}`,
      {
        method: "POST",
        headers: { apikey: config.anonKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
    const data = await response.json();
    if (
      !response.ok ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new Error("Sign-in failed");
    // Never put Google's provider tokens in the Supabase session cookie.
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now() + data.expires_in * 1000,
    };
  }
  return {
    authorizationUrl(redirectUri, challenge) {
      const url = new URL(`${config.url}/auth/v1/authorize`);
      url.search = new URLSearchParams({
        provider: "google",
        scopes: "openid email profile",
        redirect_to: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "s256",
      }).toString();
      return url.toString();
    },
    exchangeCode: (code, verifier) =>
      token("pkce", { auth_code: code, code_verifier: verifier }),
    refresh: (refreshToken) =>
      token("refresh_token", { refresh_token: refreshToken }),
    async getUser(accessToken) {
      const response = await fetcher(`${config.url}/auth/v1/user`, {
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${accessToken}`,
        },
        cache: "no-store",
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (
        typeof data.id !== "string" ||
        !data.id ||
        typeof data.email !== "string" ||
        !data.email
      )
        return null;
      return { id: data.id, email: data.email };
    },
  };
}
