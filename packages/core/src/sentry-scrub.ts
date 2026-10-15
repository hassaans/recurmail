export type SentryEvent = Record<string, unknown>;

const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const privateContentKey =
  /^(?:body|body_text|body_html|subject|recipient|recipients|to|cc|bcc|email|raw|html|text|message|data|query_string|cookies?)$/i;

function scrubValue(value: unknown, key = ""): unknown {
  if (privateContentKey.test(key)) return "[Filtered]";
  if (typeof value === "string")
    return value.replace(email, "[Filtered email]");
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        scrubValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

/** Removes recipient addresses and message content before an event reaches a Sentry transport. */
export function scrubSentryEvent<T extends object>(event: T): T {
  const scrubbed = scrubValue(event) as T;
  if (typeof (scrubbed as { message?: unknown }).message === "string")
    (scrubbed as Record<string, unknown>).message = "[Filtered error]";
  const exception = (scrubbed as Record<string, unknown>).exception;
  if (exception && typeof exception === "object") {
    const values = (exception as { values?: unknown }).values;
    if (Array.isArray(values)) {
      (exception as { values: unknown[] }).values = values.map((item) => {
        if (!item || typeof item !== "object") return item;
        return { ...item, value: "[Filtered error]" };
      });
    }
  }
  return scrubbed;
}
