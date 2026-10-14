import {
  parseDefaultSecretKey,
  resolveSupabaseSecretKey,
} from "./secret-key.ts";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("reads the default key from SUPABASE_SECRET_KEYS JSON", () => {
  equal(
    parseDefaultSecretKey(
      JSON.stringify({ default: "sb_secret_default", secondary: "ignored" }),
    ),
    "sb_secret_default",
    "default key",
  );
});

Deno.test("returns no key when the default entry is missing", () => {
  equal(
    parseDefaultSecretKey('{"other":"sb_secret_other"}'),
    undefined,
    "missing default",
  );
});

Deno.test("returns no key when SUPABASE_SECRET_KEYS is invalid JSON", () => {
  equal(parseDefaultSecretKey("{"), undefined, "invalid JSON");
});

Deno.test("falls back to explicit SUPABASE_SECRET_KEY", () => {
  equal(
    resolveSupabaseSecretKey("not-json", " sb_secret_fallback "),
    "sb_secret_fallback",
    "explicit fallback",
  );
});

Deno.test("logs a configuration error and fails closed when no key exists", () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...values) => errors.push(values);
  try {
    let threw = false;
    try {
      resolveSupabaseSecretKey(undefined, undefined);
    } catch (error) {
      threw = error instanceof Error;
    }
    equal(threw, true, "missing key throws");
    equal(errors.length, 1, "one configuration error");
    equal(errors[0][0], "[ERROR] send_due_configuration_failed", "log event");
    equal(
      (errors[0][1] as { errorCode: string }).errorCode,
      "secret_key_missing",
      "log code",
    );
  } finally {
    console.error = originalError;
  }
});
