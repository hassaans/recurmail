import { createStore } from "./store.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("store void RPC callers accept 204 responses", async () => {
  const calls: string[] = [];
  const store = createStore(
    "https://db.example.test",
    "service-key",
    async (input) => {
      calls.push(new URL(String(input)).pathname);
      return new Response(null, { status: 204 });
    },
  );

  await store.markReconnectNoticeSent("notice-1");
  await store.markReconnectNoticeFailed("notice-2", "resend_http_500");
  await store.complete({
    scheduleId: "schedule-1",
    scheduledFor: "2026-10-14T17:00:00.000Z",
    status: "sent",
    nextSendAt: "2026-10-15T17:00:00.000Z",
    messageId: "message-1",
  });
  await store.reconnect({
    scheduleId: "schedule-2",
    userId: "user-1",
    connectionId: "connection-1",
    scheduledFor: "2026-10-14T17:00:00.000Z",
    recipient: "user@example.test",
    reconnectUrl: "https://app.example.test/connect",
  });
  await store.recordFailure({
    scheduleId: "schedule-3",
    scheduledFor: "2026-10-14T17:00:00.000Z",
    errorCode: "send_failed",
  });

  assert(
    calls.join(",") ===
      [
        "/rest/v1/rpc/mark_reconnect_email_sent",
        "/rest/v1/rpc/mark_reconnect_email_failed",
        "/rest/v1/rpc/complete_due_schedule",
        "/rest/v1/rpc/mark_gmail_reconnect_needed",
        "/rest/v1/rpc/record_sender_failure",
      ].join(","),
    "all void RPCs were called",
  );
});

Deno.test("data-returning RPC with an empty body still throws", async () => {
  const store = createStore(
    "https://db.example.test",
    "service-key",
    async () => new Response(null, { status: 200 }),
  );

  let threw = false;
  try {
    await store.claim(1);
  } catch {
    threw = true;
  }
  assert(threw, "data-returning RPC must reject an empty response body");
});

Deno.test("reconnect RPC names the schedule, owner and connection", async () => {
  const bodies: Record<string, unknown>[] = [];
  const store = createStore(
    "https://db.example.test",
    "service-key",
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  );
  await store.reconnect({
    scheduleId: "schedule-2",
    userId: "user-1",
    connectionId: "connection-1",
    scheduledFor: "2026-10-14T17:00:00.000Z",
    recipient: "user@example.test",
    reconnectUrl: "https://app.example.test/connect",
  });
  assert(
    JSON.stringify(bodies[0]) ===
      JSON.stringify({
        p_schedule_id: "schedule-2",
        p_user_id: "user-1",
        p_connection_id: "connection-1",
        p_scheduled_for: "2026-10-14T17:00:00.000Z",
        p_recipient: "user@example.test",
        p_reconnect_url: "https://app.example.test/connect",
      }),
    "mark_gmail_reconnect_needed receives every per-connection argument",
  );
});
