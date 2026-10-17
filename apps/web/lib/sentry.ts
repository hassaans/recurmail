import { reactErrorCode, scrubSentryEvent } from "@recurmail/core";

type GroupableEvent = {
  exception?: { values?: { value?: unknown }[] };
  transaction?: unknown;
  fingerprint?: string[];
};

const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function beforeSend<T extends object>(
  event: T,
): T & { fingerprint?: string[] } {
  const scrubbed = scrubSentryEvent(event) as T & GroupableEvent;
  // Every React error throws from inside react-dom, so grouping by stack puts
  // them all in one issue whatever the page. Group by code and page instead.
  const code = scrubbed.exception?.values
    ?.map((item) => reactErrorCode(item.value))
    .find(Boolean);
  if (code) {
    const page =
      typeof scrubbed.transaction === "string"
        ? scrubbed.transaction.replace(id, "[id]")
        : "unknown page";
    scrubbed.fingerprint = ["react-error", code, page];
  }
  return scrubbed;
}
