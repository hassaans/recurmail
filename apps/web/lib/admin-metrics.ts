import "server-only";
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
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
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
