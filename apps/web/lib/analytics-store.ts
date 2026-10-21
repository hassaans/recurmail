import "server-only";
import type { AnalyticsEventRow } from "./analytics-events";
import type { FirstTouch } from "./analytics-source";

export interface AttributionRow {
  user_id: string;
  anonymous_id: string | null;
  user_email: string | null;
  signup_ip: string | null;
  signup_user_agent: string | null;
  first_source: string;
  first_referrer_host: string | null;
  first_utm_source: string | null;
  first_utm_medium: string | null;
  first_utm_campaign: string | null;
  first_utm_term: string | null;
  first_utm_content: string | null;
  first_landing_path: string | null;
  first_seen_at: string | null;
  signed_up_at: string;
}

/**
 * How much one address may send to /api/events in a rolling window. A
 * person reading the site sends a few events per page, so these leave room
 * for a busy shared office while capping what a script can add.
 */
export interface ClientEventBudget {
  windowSeconds: number;
  maxEvents: number;
  maxBrowsers: number;
}

export interface AnalyticsStore {
  insertEvent(row: AnalyticsEventRow): Promise<void>;
  /**
   * Stores a browser event through record_client_event, which refuses it
   * once the sending address has spent its budget. Returns whether it was
   * stored.
   */
  recordClientEvent(
    row: AnalyticsEventRow,
    budget: ClientEventBudget,
  ): Promise<boolean>;
  hasAttribution(userId: string): Promise<boolean>;
  insertAttribution(row: AttributionRow): Promise<void>;
  /** The output of get_analytics_summary for the trailing number of days. */
  summary(days: number): Promise<unknown>;
}

export class AnalyticsStorageError extends Error {
  constructor(readonly operation: string) {
    super(`Analytics storage failed: ${operation}`);
  }
}

/** The attribution row for a new user, from whatever the browser remembered. */
export function attributionFrom(
  userId: string,
  anonymousId: string | null,
  touch: FirstTouch | null,
  signedUpAt: string,
): Omit<AttributionRow, "user_email" | "signup_ip" | "signup_user_agent"> {
  return {
    user_id: userId,
    anonymous_id: anonymousId,
    first_source: touch?.source ?? "direct",
    first_referrer_host: touch?.referrer_host ?? null,
    first_utm_source: touch?.utm_source ?? null,
    first_utm_medium: touch?.utm_medium ?? null,
    first_utm_campaign: touch?.utm_campaign ?? null,
    first_utm_term: touch?.utm_term ?? null,
    first_utm_content: touch?.utm_content ?? null,
    first_landing_path: touch?.landing_path ?? null,
    first_seen_at: touch?.first_seen_at ?? null,
    signed_up_at: signedUpAt,
  };
}

/**
 * Service-role PostgREST access to the analytics tables; nothing here runs as
 * the user. Route handlers await these writes after the real work is done, so
 * each call is cut off after `timeoutMs` (the admin summary after
 * `summaryTimeoutMs`): a slow or stuck database can lose an event but cannot
 * hold up a response.
 */
export function createAnalyticsStore(config: {
  url: string;
  secretKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  summaryTimeoutMs?: number;
}): AnalyticsStore {
  const fetcher = config.fetcher ?? fetch;
  const timeoutMs = config.timeoutMs ?? 2000;
  const summaryTimeoutMs = config.summaryTimeoutMs ?? 10_000;
  async function request(
    path: string,
    params: Record<string, string>,
    method: "GET" | "POST",
    operation: string,
    body?: unknown,
    timeout = timeoutMs,
  ): Promise<Response> {
    const url = new URL(`/rest/v1/${path}`, config.url);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        apikey: config.secretKey,
        "Content-Type": "application/json",
        ...(method === "POST" && !path.startsWith("rpc/")
          ? { Prefer: "return=minimal" }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new AnalyticsStorageError(operation);
    return response;
  }
  return {
    async insertEvent(row) {
      await request("analytics_events", {}, "POST", "insert_event", row);
    },
    async recordClientEvent(row, budget) {
      const response = await request(
        "rpc/record_client_event",
        {},
        "POST",
        "record_client_event",
        {
          p_event: row,
          p_window_seconds: budget.windowSeconds,
          p_max_events: budget.maxEvents,
          p_max_browsers: budget.maxBrowsers,
        },
      );
      const stored: unknown = await response.json();
      if (typeof stored !== "boolean")
        throw new AnalyticsStorageError("record_client_event");
      return stored;
    },
    async hasAttribution(userId) {
      const response = await request(
        "user_attribution",
        { user_id: `eq.${userId}`, select: "user_id", limit: "1" },
        "GET",
        "read_attribution",
      );
      const rows: unknown = await response.json();
      if (!Array.isArray(rows))
        throw new AnalyticsStorageError("read_attribution");
      return rows.length > 0;
    },
    async insertAttribution(row) {
      await request("user_attribution", {}, "POST", "insert_attribution", row);
    },
    async summary(days) {
      const response = await request(
        "rpc/get_analytics_summary",
        {},
        "POST",
        "get_analytics_summary",
        { p_days: days },
        summaryTimeoutMs,
      );
      return response.json();
    },
  };
}
