import {
  beforeSend,
  captureError,
  captureFailureRate,
  flushSentry,
  initSentry,
  SEND_DUE_MONITOR_CONFIG,
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

Deno.test("the in-progress check-in carries the monitor config so Sentry creates the monitor", () => {
  const calls: unknown[][] = [];
  const checkIn = startCronCheckIn(
    "https://public@example.ingest.sentry.io/1",
    " send-due-every-minute ",
    (...args) => {
      calls.push(args);
      return "check-in-1";
    },
  );
  if (
    JSON.stringify(checkIn) !==
    JSON.stringify({
      monitorSlug: "send-due-every-minute",
      checkInId: "check-in-1",
    })
  )
    throw new Error(`unexpected check-in ${JSON.stringify(checkIn)}`);
  const expected = [
    { monitorSlug: "send-due-every-minute", status: "in_progress" },
    {
      schedule: { type: "crontab", value: "* * * * *" },
      timezone: "UTC",
      checkinMargin: 5,
      maxRuntime: 5,
      failureIssueThreshold: 1,
      recoveryThreshold: 1,
    },
  ];
  if (JSON.stringify(calls) !== JSON.stringify([expected]))
    throw new Error(`unexpected captureCheckIn calls ${JSON.stringify(calls)}`);
  if (SEND_DUE_MONITOR_CONFIG.schedule.value !== "* * * * *")
    throw new Error("monitor schedule must match the pg_cron job");
});

Deno.test("flushSentry waits for delivery only when a DSN is set and never throws", async () => {
  const timeouts: (number | undefined)[] = [];
  const flush = (timeout?: number) => {
    timeouts.push(timeout);
    return Promise.resolve(true);
  };
  await flushSentry(undefined, flush);
  await flushSentry("  ", flush);
  if (timeouts.length !== 0) throw new Error("flushed without a DSN");
  await flushSentry("https://public@example.ingest.sentry.io/1", flush);
  if (JSON.stringify(timeouts) !== "[2000]")
    throw new Error(`unexpected flush timeouts ${JSON.stringify(timeouts)}`);
  await flushSentry("https://public@example.ingest.sentry.io/1", () =>
    Promise.reject(new Error("network down")),
  );
});
