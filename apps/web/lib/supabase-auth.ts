import "server-only";

export interface SignedInUser {
  id: string;
  email: string;
  /** When the Supabase user was created; absent when Supabase did not say. */
  createdAt?: string;
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
  secretKey: string;
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
            apikey: config.secretKey,
          },
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error("Account deletion failed");
    },
  };
}

export interface SupabaseAuth {
  exchangeIdToken(idToken: string, nonce: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  getUser(accessToken: string): Promise<SignedInUser | null>;
}

export function createSupabaseAuth(config: {
  url: string;
  publishableKey: string;
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
        headers: {
          apikey: config.publishableKey,
          "Content-Type": "application/json",
        },
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
    exchangeIdToken: (idToken, nonce) =>
      token("id_token", { provider: "google", id_token: idToken, nonce }),
    refresh: (refreshToken) =>
      token("refresh_token", { refresh_token: refreshToken }),
    async getUser(accessToken) {
      const response = await fetcher(`${config.url}/auth/v1/user`, {
        headers: {
          apikey: config.publishableKey,
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
      return {
        id: data.id,
        email: data.email,
        ...(typeof data.created_at === "string" &&
        !Number.isNaN(Date.parse(data.created_at))
          ? { createdAt: data.created_at }
          : {}),
      };
    },
  };
}
