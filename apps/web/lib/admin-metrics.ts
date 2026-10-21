import "server-only";
import { createAnalyticsStore } from "./analytics-store";
import { readSession } from "./auth-flow";
import { createSupabaseAuth } from "./supabase-auth";

export type AdminMetrics = {
  signed_up_users: number;
  connected_gmail_accounts: number;
  active_schedules: number;
  sends_last_24_hours: number;
  kept_sending_30_days: number;
  failed_last_hour: number;
  attempted_last_hour: number;
  failure_rate_last_hour: number;
};

type AdminEnvironment = Record<string, string | undefined>;

export const FUNNEL_STEPS = [
  "page_view",
  "signup_started",
  "signup_completed",
  "gmail_connected",
  "schedule_created",
] as const;

/** get_analytics_summary for one trailing window. */
export type AnalyticsSummary = {
  days: number;
  visitors: number;
  signups: number;
  funnel: Record<(typeof FUNNEL_STEPS)[number], number>;
  sources: { source: string; visitors: number; signups: number }[];
  landing_paths: { path: string; visitors: number }[];
  referrers: { host: string; visitors: number }[];
  events: { event: string; count: number }[];
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function rows<T>(
  value: unknown,
  pick: (row: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) =>
    row && typeof row === "object"
      ? (pick(row as Record<string, unknown>) ?? [])
      : [],
  );
}

const label = (value: unknown): string | null =>
  typeof value === "string" && value ? value.slice(0, 512) : null;

/** The summary with every field present, whatever the database returned. */
export function validSummary(value: unknown, days: number): AnalyticsSummary {
  const summary =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const funnel =
    summary.funnel && typeof summary.funnel === "object"
      ? (summary.funnel as Record<string, unknown>)
      : {};
  return {
    days,
    visitors: count(summary.visitors),
    signups: count(summary.signups),
    funnel: Object.fromEntries(
      FUNNEL_STEPS.map((step) => [step, count(funnel[step])]),
    ) as AnalyticsSummary["funnel"],
    sources: rows(summary.sources, (row) => {
      const source = label(row.source);
      return source
        ? { source, visitors: count(row.visitors), signups: count(row.signups) }
        : null;
    }),
    landing_paths: rows(summary.landing_paths, (row) => {
      const path = label(row.path);
      return path ? { path, visitors: count(row.visitors) } : null;
    }),
    referrers: rows(summary.referrers, (row) => {
      const host = label(row.host);
      return host ? { host, visitors: count(row.visitors) } : null;
    }),
    events: rows(summary.events, (row) => {
      const event = label(row.event);
      return event ? { event, count: count(row.count) } : null;
    }),
  };
}

/**
 * The acquisition summaries for the admin page. Only called once the
 * caller has passed loadAdminMetrics, which is where the owner check lives.
 * Returns null when the analytics tables are unreachable, so the rest of
 * the admin page still renders.
 */
export async function loadAcquisition(
  windows: number[],
  env: AdminEnvironment = process.env,
  fetcher: typeof fetch = fetch,
): Promise<AnalyticsSummary[] | null> {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!supabaseUrl || !secretKey) return null;
  const store = createAnalyticsStore({
    url: new URL(supabaseUrl).origin,
    secretKey,
    fetcher,
  });
  try {
    return await Promise.all(
      windows.map(async (days) =>
        validSummary(await store.summary(days), days),
      ),
    );
  } catch {
    console.error("[ERROR] admin_acquisition_failed");
    return null;
  }
}

function validMetrics(value: unknown): AdminMetrics {
  if (!value || typeof value !== "object")
    throw new Error("Admin metrics response is invalid");
  const metrics = value as Record<string, unknown>;
  const keys: (keyof AdminMetrics)[] = [
    "signed_up_users",
    "connected_gmail_accounts",
    "active_schedules",
    "sends_last_24_hours",
    "kept_sending_30_days",
    "failed_last_hour",
    "attempted_last_hour",
    "failure_rate_last_hour",
  ];
  for (const key of keys) {
    if (typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]))
      throw new Error("Admin metrics response is invalid");
  }
  return Object.fromEntries(
    keys.map((key) => [key, metrics[key]]),
  ) as AdminMetrics;
}

export async function loadAdminMetrics(
  request: Request,
  env: AdminEnvironment = process.env,
  fetcher: typeof fetch = fetch,
): Promise<AdminMetrics | null> {
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY?.trim();
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  const admins = new Set(
    (env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (
    !encryptionKey ||
    !supabaseUrl ||
    !publishableKey ||
    !secretKey ||
    admins.size === 0
  )
    return null;

  const session = readSession(request, encryptionKey);
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = await createSupabaseAuth({
    url: new URL(supabaseUrl).origin,
    publishableKey,
    fetcher,
  }).getUser(session.accessToken);
  if (!user || !admins.has(user.email.trim().toLowerCase())) return null;

  const response = await fetcher(
    `${new URL(supabaseUrl).origin}/rest/v1/rpc/get_admin_metrics`,
    {
      method: "POST",
      headers: {
        apikey: secretKey,
        "content-type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error("Admin metrics are unavailable");
  return validMetrics(await response.json());
}
