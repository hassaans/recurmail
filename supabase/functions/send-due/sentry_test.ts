import {
  beforeSend,
  captureError,
  captureFailureRate,
  initSentry,
  startCronCheckIn,
} from "./sentry.ts";

Deno.test("send-due beforeSend scrubs error events before captured transport", () => {
  const captured: Record<string, unknown>[] = [];
  const fakeTransport = (event: Record<string, unknown>) =>
    captured.push(event);
  fakeTransport(
    beforeSend({
      message: "Send failed for recipient@example.com: Renewal notice",
      exception: {
        values: [
          {
            type: "Error",
            value: "recipient@example.com Renewal notice private body",
          },
        ],
      },
      extra: {
        recipient: "recipient@example.com",
        subject: "Renewal notice",
        body: "private body",
        detail: "Error request for owner@example.com",
        request: { data: "Renewal notice private body" },
        breadcrumbs: [{ message: "Renewal notice" }],
      },
    }),
  );
  const serialized = JSON.stringify(captured);
  if (
    serialized.includes("recipient@example.com") ||
    serialized.includes("Renewal notice") ||
    serialized.includes("private body")
  )
    throw new Error("send-due Sentry event leaked email content");
  if (!serialized.includes("[Filtered email]") || captured.length !== 1)
    throw new Error(
      "send-due Sentry beforeSend did not scrub the captured event",
    );
});

Deno.test("Sentry capture is a no-op when its DSN is unset", () => {
  initSentry(undefined);
  captureError(new Error("private recipient@example.com"), undefined);
  captureFailureRate(0.25, undefined);
  if (startCronCheckIn(undefined, "send-due-every-minute") !== null)
    throw new Error("Sentry cron check-in started without a DSN");
});
