export function parseDefaultSecretKey(
  secretKeysJson: string | undefined,
): string | undefined {
  if (!secretKeysJson?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(secretKeysJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const defaultKey = (parsed as Record<string, unknown>).default;
    return typeof defaultKey === "string" && defaultKey.trim()
      ? defaultKey.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSupabaseSecretKey(
  secretKeysJson: string | undefined,
  explicitSecretKey: string | undefined,
): string {
  const injectedKey = parseDefaultSecretKey(secretKeysJson);
  if (injectedKey) return injectedKey;

  const fallback = explicitSecretKey?.trim();
  if (fallback) return fallback;

  const errorCode = secretKeysJson?.trim()
    ? "secret_keys_invalid_or_missing_default"
    : "secret_key_missing";
  console.error("[ERROR] send_due_configuration_failed", { errorCode });
  throw new Error("Missing Supabase secret key configuration");
}
