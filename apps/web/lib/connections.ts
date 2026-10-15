import "server-only";

export const MAX_GMAIL_CONNECTIONS = 10;
export const PUBLIC_CONNECTION_COLUMNS =
  "id,user_id,google_email,is_workspace,status,connected_at";

export interface PublicConnection {
  id: string;
  user_id: string;
  google_email: string;
  is_workspace: boolean;
  status: "connected" | "needs_reconnect" | "disconnected";
  connected_at: string;
}
/**
 * A row to write. The database assigns the id. The Google account id is
 * server-side only: it is never in PUBLIC_CONNECTION_COLUMNS and the
 * authenticated role has no select grant on it.
 */
export interface StoredConnection extends Omit<PublicConnection, "id"> {
  google_sub: string;
  encrypted_refresh_token: string;
}
export interface ConnectionCredential {
  google_email: string;
  encrypted_refresh_token: string;
}
export interface ConnectionStore {
  /** Every account the signed-in user has connected, oldest first, read with the user's own session. */
  list(userId: string, accessToken: string): Promise<PublicConnection[]>;
  /** One connection's credential, read server-side. */
  readCredential(
    userId: string,
    connectionId: string,
  ): Promise<ConnectionCredential | null>;
  /** Every encrypted token the user holds, for account deletion. */
  readEncryptedTokens(userId: string): Promise<string[]>;
  /**
   * Inserts the account, or updates the row that already holds it. A row is
   * the same account when it has the same Google account id, or when it has
   * no id yet and the same address (a row written before ids were stored,
   * which then gets its id filled in). The address on the matched row is
   * refreshed, so a renamed account keeps its row and its schedules. Throws
   * ConnectionLimitError when the user already has the maximum number of
   * accounts, and ConnectionAddressConflictError when the address belongs to
   * one of the user's rows that is a different Google account.
   */
  save(connection: StoredConnection): Promise<void>;
  pauseSchedules(userId: string, connectionId: string): Promise<void>;
  delete(userId: string, connectionId: string): Promise<void>;
}

export class ConnectionLimitError extends Error {
  constructor() {
    super(`A user can connect at most ${MAX_GMAIL_CONNECTIONS} Gmail accounts`);
  }
}

/**
 * The address is already on one of the user's connections, and that row is a
 * different Google account. Its token and schedules are left alone.
 */
export class ConnectionAddressConflictError extends Error {
  readonly code = "address_in_use";
  constructor() {
    super("The address belongs to a different connected Google account");
  }
}

/** A PostgREST response that was not ok, keeping the status for callers that can recover from one. */
class ConnectionStorageError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Connection storage failed");
    this.status = status;
  }
}

export const isConnectionId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function publicConnection(row: Record<string, unknown>): PublicConnection {
  // Explicit projection protects UI callers even if a provider returns extra columns.
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    google_email: String(row.google_email),
    is_workspace: row.is_workspace === true,
    status: row.status as PublicConnection["status"],
    connected_at: String(row.connected_at),
  };
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
        Prefer: "return=minimal",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    if (!response.ok) throw new ConnectionStorageError(response.status);
    return response;
  }
  async function rows(
    table: string,
    params: Record<string, string>,
    accessToken: string | undefined,
    service: boolean,
  ): Promise<Record<string, unknown>[]> {
    const response = await request(table, params, "GET", accessToken, service);
    const body: unknown = await response.json();
    if (
      !Array.isArray(body) ||
      body.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      throw new Error("Connection storage failed");
    return body;
  }
  return {
    async list(userId, accessToken) {
      const result = await rows(
        "gmail_connections",
        {
          user_id: `eq.${userId}`,
          select: PUBLIC_CONNECTION_COLUMNS,
          order: "connected_at.asc,id.asc",
        },
        accessToken,
        false,
      );
      return result
        .filter((row) => row.user_id === userId)
        .map(publicConnection);
    },
    async readCredential(userId, connectionId) {
      if (!isConnectionId(connectionId)) return null;
      const [row] = await rows(
        "gmail_connections",
        {
          id: `eq.${connectionId}`,
          user_id: `eq.${userId}`,
          select: "google_email,encrypted_refresh_token",
        },
        undefined,
        true,
      );
      if (!row) return null;
      if (
        typeof row.google_email !== "string" ||
        typeof row.encrypted_refresh_token !== "string"
      )
        throw new Error("Connection storage failed");
      return {
        google_email: row.google_email,
        encrypted_refresh_token: row.encrypted_refresh_token,
      };
    },
    async readEncryptedTokens(userId) {
      const result = await rows(
        "gmail_connections",
        { user_id: `eq.${userId}`, select: "encrypted_refresh_token" },
        undefined,
        true,
      );
      return result
        .map((row) => row.encrypted_refresh_token)
        .filter((token): token is string => typeof token === "string");
    },
    async save(connection) {
      const wanted = connection.google_email.toLowerCase();
      const ownRows = () =>
        rows(
          "gmail_connections",
          {
            user_id: `eq.${connection.user_id}`,
            select: "id,google_email,google_sub",
          },
          undefined,
          true,
        );
      // The Google account id is the key. A row without one was written
      // before ids were stored, so the same address claims it and the update
      // fills the id in. An address held by a row with a different id is
      // another Google account; that row keeps its token and schedules.
      const sameAccount = (list: Record<string, unknown>[]) => {
        const byId = list.find(
          (row) => row.google_sub === connection.google_sub,
        );
        if (byId) return byId;
        const byAddress = list.find(
          (row) =>
            typeof row.google_email === "string" &&
            row.google_email.toLowerCase() === wanted,
        );
        if (byAddress && typeof byAddress.google_sub === "string")
          throw new ConnectionAddressConflictError();
        return byAddress;
      };
      const update = async (id: unknown) => {
        try {
          await request(
            "gmail_connections",
            { id: `eq.${String(id)}`, user_id: `eq.${connection.user_id}` },
            "PATCH",
            undefined,
            true,
            {
              google_sub: connection.google_sub,
              google_email: connection.google_email,
              is_workspace: connection.is_workspace,
              encrypted_refresh_token: connection.encrypted_refresh_token,
              status: connection.status,
              connected_at: connection.connected_at,
            },
          );
        } catch (error) {
          // The unique indexes refused the update: another of the user's rows
          // already holds this address or this account id.
          if (error instanceof ConnectionStorageError && error.status === 409)
            throw new ConnectionAddressConflictError();
          throw error;
        }
      };
      // Neither index can be targeted by an upsert through PostgREST (one is
      // an expression, the other is partial), so the match is done here.
      const existing = await ownRows();
      const match = sameAccount(existing);
      if (match) {
        await update(match.id);
        return;
      }
      if (existing.length >= MAX_GMAIL_CONNECTIONS)
        throw new ConnectionLimitError();
      try {
        await request(
          "gmail_connections",
          {},
          "POST",
          undefined,
          true,
          connection,
        );
      } catch (error) {
        // Two consents for the same new account can both miss the lookup
        // above. The unique index lets one insert through and answers the
        // other with a conflict. The account is present either way, so give
        // the row that won this token, under the same matching rules.
        if (!(error instanceof ConnectionStorageError) || error.status !== 409)
          throw error;
        const winner = sameAccount(await ownRows());
        if (!winner) throw error;
        await update(winner.id);
      }
    },
    async pauseSchedules(userId, connectionId) {
      await request(
        "schedules",
        { user_id: `eq.${userId}`, gmail_connection_id: `eq.${connectionId}` },
        "PATCH",
        undefined,
        true,
        { status: "paused", updated_at: new Date().toISOString() },
      );
    },
    async delete(userId, connectionId) {
      await request(
        "gmail_connections",
        { id: `eq.${connectionId}`, user_id: `eq.${userId}` },
        "DELETE",
        undefined,
        true,
      );
    },
  };
}
