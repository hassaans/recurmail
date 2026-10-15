import "server-only";

export interface PublicConnection {
  user_id: string;
  google_email: string;
  is_workspace: boolean;
  status: "connected" | "needs_reconnect" | "disconnected";
  connected_at: string;
}
export interface StoredConnection extends PublicConnection {
  encrypted_refresh_token: string;
}
export interface ConnectionStore {
  readPublic(
    userId: string,
    accessToken: string,
  ): Promise<PublicConnection | null>;
  readEncryptedToken(userId: string): Promise<string | null>;
  save(connection: StoredConnection): Promise<void>;
  pauseSchedules(userId: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

export function createConnectionStore(config: {
  url: string;
  publishableKey: string;
  secretKey: string;
  fetcher?: typeof fetch;
}): ConnectionStore {
  const fetcher = config.fetcher ?? fetch;
  async function request(
    table: string,
    params: Record<string, string>,
    method: string,
    accessToken: string | undefined,
    service: boolean,
    body?: object,
  ) {
    const url = new URL(`${config.url}/rest/v1/${table}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        apikey: service ? config.secretKey : config.publishableKey,
        ...(!service ? { Authorization: `Bearer ${accessToken}` } : {}),
        "Content-Type": "application/json",
        Prefer:
          method === "POST"
            ? "resolution=merge-duplicates,return=minimal"
            : "return=minimal",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Connection storage failed");
    return response;
  }
  return {
    async readPublic(userId, accessToken) {
      const response = await request(
        "gmail_connections",
        {
          user_id: `eq.${userId}`,
          select: "user_id,google_email,is_workspace,status,connected_at",
        },
        "GET",
        accessToken,
        false,
      );
      const [row] = await response.json();
      // Explicit projection protects UI callers even if a provider returns extra columns.
      return row
        ? {
            user_id: row.user_id,
            google_email: row.google_email,
            is_workspace: row.is_workspace,
            status: row.status,
            connected_at: row.connected_at,
          }
        : null;
    },
    async readEncryptedToken(userId) {
      const response = await request(
        "gmail_connections",
        { user_id: `eq.${userId}`, select: "encrypted_refresh_token" },
        "GET",
        undefined,
        true,
      );
      const [row] = await response.json();
      return row?.encrypted_refresh_token ?? null;
    },
    async save(connection) {
      await request(
        "gmail_connections",
        { on_conflict: "user_id" },
        "POST",
        undefined,
        true,
        connection,
      );
    },
    async pauseSchedules(userId) {
      await request(
        "schedules",
        { user_id: `eq.${userId}` },
        "PATCH",
        undefined,
        true,
        { status: "paused", updated_at: new Date().toISOString() },
      );
    },
    async delete(userId) {
      await request(
        "gmail_connections",
        { user_id: `eq.${userId}` },
        "DELETE",
        undefined,
        true,
      );
    },
  };
}
