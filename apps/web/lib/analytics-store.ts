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

export interface AnalyticsStore {
  insertEvent(row: AnalyticsEventRow): Promise<void>;
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

/** Service-role PostgREST access to the analytics tables; nothing here runs as the user. */
export function createAnalyticsStore(config: {
  url: string;
  secretKey: string;
  fetcher?: typeof fetch;
}): AnalyticsStore {
  const fetcher = config.fetcher ?? fetch;
  async function request(
    path: string,
    params: Record<string, string>,
    method: "GET" | "POST",
    operation: string,
    body?: unknown,
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
    });
    if (!response.ok) throw new AnalyticsStorageError(operation);
    return response;
  }
  return {
    async insertEvent(row) {
      await request("analytics_events", {}, "POST", "insert_event", row);
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
      );
      return response.json();
    },
  };
}
