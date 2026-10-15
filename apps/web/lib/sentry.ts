import { scrubSentryEvent } from "@recurmail/core";

export function beforeSend<T extends object>(event: T): T {
  return scrubSentryEvent(event);
}
