import { decryptRefreshToken } from "./crypto.ts";
import { type ClaimedSchedule, runSender, type SenderStore } from "./engine.ts";
import { GmailError } from "./gmail.ts";
import { createStore } from "./store.ts";

Deno.chdir(new URL("../../..", import.meta.url));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual,
      )}`,
    );
  }
}

Deno.test("Supabase service requests send the secret key only as apikey", async () => {
  const secretKey = "sb_secret_test-key";
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    if (String(input).endsWith("/rpc/get_admin_metrics")) {
      return Response.json({
        failed_last_hour: 1,
        attempted_last_hour: 2,
        failure_rate_last_hour: 0.5,
      });
    }
    return Response.json([]);
  };
  const store = createStore("https://db.example.test", secretKey, fetcher);
  await store.failureMetrics?.();
  await store.claim(1);
  await store.claimReconnectNotices(1);
  await store.markReconnectNoticeSent("notice-1");
  await store.markReconnectNoticeFailed("notice-1", "send_failed");
  await store.reclaimStaleSending("2026-10-14T00:00:00.000Z");
  await store.recordFailure({
    scheduleId: "schedule-1",
    scheduledFor: "2026-10-14T00:00:00.000Z",
    errorCode: "send_failed",
  });
  await store.complete({
    scheduleId: "schedule-1",
    scheduledFor: "2026-10-14T00:00:00.000Z",
    status: "sent",
    nextSendAt: "2026-10-15T00:00:00.000Z",
  });
  await store.reconnect({
    scheduleId: "schedule-1",
    userId: "user-1",
    connectionId: "connection-1",
    scheduledFor: "2026-10-14T00:00:00.000Z",
    recipient: "user@example.test",
    reconnectUrl: "https://app.example.test/connect",
  });
  await store.heartbeat({
    id: "heartbeat-1",
    startedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:01.000Z",
    claimed: 0,
    sent: 0,
    failed: 0,
    deferred: 0,
    noticesSent: 0,
    noticesFailed: 0,
    failureRateLastHour: null,
    failedLastHour: null,
    attemptedLastHour: null,
  });

  equal(requests.length, 10, "service request count");
  for (const request of requests) {
    const expected = request.url.endsWith("/sender_heartbeats")
      ? {
          apikey: secretKey,
          "content-type": "application/json",
          prefer: "return=minimal",
        }
      : { apikey: secretKey, "content-type": "application/json" };
    equal(Object.fromEntries(request.headers), expected, "service headers");
    assert(
      !request.headers.has("authorization"),
      "service request must not send Authorization",
    );
  }
});

async function nodeEncryptedToken(): Promise<{
  envelope: string;
  key: string;
  owner: string;
}> {
  const owner = "user-interop-1";
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const script = `import { encryptRefreshToken } from './apps/web/lib/crypto.ts'; console.log(encryptRefreshToken('refresh-token-from-node', ${JSON.stringify(
    key,
  )}, ${JSON.stringify(owner)}));`;
  const child = new Deno.Command("node", {
    args: [
      "--experimental-strip-types",
      "--experimental-loader",
      `${Deno.cwd()}/supabase/functions/send-due/node-loader.mjs`,
      "--input-type=module",
      "-e",
      script,
    ],
    cwd: Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });
  const result = await child.output();
  assert(result.code === 0, new TextDecoder().decode(result.stderr));
  return {
    envelope: new TextDecoder().decode(result.stdout).trim(),
    key,
    owner,
  };
}

Deno.test("Deno WebCrypto decrypts a token encrypted by the Node helper", async () => {
  const { envelope, key, owner } = await nodeEncryptedToken();
  equal(
    await decryptRefreshToken(envelope, key, owner),
    "refresh-token-from-node",
    "cross-runtime token",
  );
  let rejected = false;
  try {
    await decryptRefreshToken(envelope, key, "another-user");
  } catch {
    rejected = true;
  }
  assert(rejected, "owner AAD must reject a different user");
});

const dueSchedule = (
  encrypted: string,
  userId = "user-interop-1",
): ClaimedSchedule => ({
  schedule_id: "schedule-1",
  user_id: userId,
  gmail_connection_id: "connection-1",
  scheduled_for: "2026-10-14T17:00:00.000Z",
  subject: "hello",
  body_text: "a recurring note",
  body_html: null,
  to: ["inbox@example.test"],
  cc: [],
  bcc: [],
  rrule: "FREQ=DAILY;BYHOUR=17;BYMINUTE=0;BYSECOND=0",
  timezone: "UTC",
  encrypted_refresh_token: encrypted,
  google_email: "sender@example.test",
});

function recordingStore(schedules: ClaimedSchedule[]): SenderStore & {
  completed: unknown[];
  reconnects: unknown[];
  heartbeats: unknown[];
  reclaimed: unknown[];
  failureLogs: unknown[];
} {
  const state = {
    completed: [] as unknown[],
    reconnects: [] as unknown[],
    heartbeats: [] as unknown[],
    reclaimed: [] as unknown[],
    failureLogs: [] as unknown[],
  };
  return {
    ...state,
    async claim() {
      return schedules;
    },
    async claimReconnectNotices() {
      return [];
    },
    async markReconnectNoticeSent() {},
    async markReconnectNoticeFailed() {},
    async reclaimStaleSending() {
      return state.reclaimed as ClaimedSchedule[];
    },
    async recordFailure(value) {
      state.failureLogs.push(value);
    },
    async complete(value) {
      state.completed.push(value);
    },
    async reconnect(value) {
      state.reconnects.push(value);
    },
    async failureMetrics() {
      return { failed: 2, attempted: 20, rate: 0.1 };
    },
    async heartbeat(value) {
      state.heartbeats.push(value);
    },
  };
}

async function fakeGoogleServer(
  gmailStatus = 200,
  tokenError?: string,
): Promise<{ url: string; requests: Request[]; close: () => Promise<void> }> {
  const requests: Request[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      requests.push(request.clone());
      if (new URL(request.url).pathname === "/token") {
        if (tokenError) {
          return Response.json({ error: tokenError }, { status: 400 });
        }
        return Response.json({
          access_token: "fake-access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (
        new URL(request.url).pathname === "/gmail/v1/users/me/messages/send"
      ) {
        if (gmailStatus !== 200) {
          return Response.json(
            {
              error: {
                code: gmailStatus,
                errors: [
                  {
                    reason:
                      gmailStatus === 429
                        ? "rateLimitExceeded"
                        : "backendError",
                  },
                ],
              },
            },
            { status: gmailStatus },
          );
        }
        return Response.json({ id: "fake-message-id" });
      }
      return new Response("not found", { status: 404 });
    },
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  return { url, requests, close: () => server.shutdown() };
}

Deno.test("fake Gmail HTTP E2E sends a MIME message and records sent send_log data", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const fake = await fakeGoogleServer();
  const store = recordingStore([dueSchedule(envelope)]);
  const fakeFetch: typeof fetch = (input, init) => {
    const original = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const target =
      original.pathname === "/token"
        ? "/token"
        : "/gmail/v1/users/me/messages/send";
    return fetch(`${fake.url}${target}`, init);
  };
  try {
    const result = await runSender(store, {
      key,
      clientId: "fake-client",
      clientSecret: "fake-secret",
      appUrl: "https://recurmail.example.test",
      now: () => new Date("2026-10-14T17:00:01.000Z"),
      fetcher: fakeFetch,
    });
    equal(
      result,
      {
        claimed: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        notices_sent: 0,
        notices_failed: 0,
      },
      "sender result",
    );
    equal(
      store.completed,
      [
        {
          scheduleId: "schedule-1",
          scheduledFor: "2026-10-14T17:00:00.000Z",
          status: "sent",
          nextSendAt: "2026-10-15T17:00:00.000Z",
          messageId: "fake-message-id",
        },
      ],
      "sent send_log record",
    );
    equal(store.heartbeats.length, 1, "heartbeat row");
    assert(
      fake.requests.length === 2,
      "OAuth and Gmail endpoints were called over HTTP",
    );
  } finally {
    await fake.close();
  }
});

Deno.test("successful send with 204 completion is counted as sent", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith("/rpc/reclaim_stale_sending")) {
      return Response.json([]);
    }
    if (url.pathname.endsWith("/rpc/claim_due_schedules")) {
      return Response.json([dueSchedule(envelope)]);
    }
    if (url.pathname.endsWith("/rpc/complete_due_schedule")) {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/rpc/get_admin_metrics")) {
      return Response.json({
        failed_last_hour: 0,
        attempted_last_hour: 1,
        failure_rate_last_hour: 0,
      });
    }
    if (url.pathname.endsWith("/sender_heartbeats")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected store request: ${url.pathname}`);
  };
  const store = createStore("https://db.example.test", "service-key", fetcher);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const result = await runSender(store, {
      key,
      clientId: "fake-client",
      clientSecret: "fake-secret",
      appUrl: "https://recurmail.example.test",
      now: () => new Date("2026-10-14T17:00:01.000Z"),
      send: async () => "accepted-message",
    });

    equal(
      result,
      {
        claimed: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        notices_sent: 0,
        notices_failed: 0,
      },
      "sender result after a void completion response",
    );
    assert(
      requests.includes("/rest/v1/rpc/complete_due_schedule"),
      "sender called the completion RPC",
    );
    assert(
      !errors.some((args) =>
        JSON.stringify(args).includes("post_send_store_failed"),
      ),
      "no post_send_store_failed log is emitted",
    );
  } finally {
    console.error = originalError;
  }
});

Deno.test("Gmail 429 defers one hour without pausing the schedule", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const fake = await fakeGoogleServer(429);
  const store = recordingStore([dueSchedule(envelope)]);
  const fakeFetch: typeof fetch = (input, init) => {
    const original = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return fetch(
      `${fake.url}${
        original.pathname === "/token"
          ? "/token"
          : "/gmail/v1/users/me/messages/send"
      }`,
      init,
    );
  };
  try {
    await runSender(store, {
      key,
      clientId: "fake",
      clientSecret: "fake",
      appUrl: "https://recurmail.example.test",
      now: () => new Date("2026-10-14T17:00:01.000Z"),
      fetcher: fakeFetch,
    });
    equal(
      store.completed,
      [
        {
          scheduleId: "schedule-1",
          scheduledFor: "2026-10-14T17:00:00.000Z",
          status: "deferred",
          nextSendAt: "2026-10-14T18:00:01.000Z",
          errorCode: "gmail_quota_deferred",
        },
      ],
      "deferred send_log row",
    );
    equal(store.reconnects, [], "quota does not pause or reconnect");
  } finally {
    await fake.close();
  }
});

Deno.test("invalid_grant pauses through the reconnect outbox", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const fake = await fakeGoogleServer(200, "invalid_grant");
  const store = recordingStore([dueSchedule(envelope)]);
  const fakeFetch: typeof fetch = (input, init) => {
    const original = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return fetch(
      `${fake.url}${
        original.pathname === "/token"
          ? "/token"
          : "/gmail/v1/users/me/messages/send"
      }`,
      init,
    );
  };
  try {
    await runSender(store, {
      key,
      clientId: "fake",
      clientSecret: "fake",
      appUrl: "https://recurmail.example.test",
      fetcher: fakeFetch,
    });
    equal(
      store.reconnects,
      [
        {
          scheduleId: "schedule-1",
          userId: "user-interop-1",
          connectionId: "connection-1",
          scheduledFor: "2026-10-14T17:00:00.000Z",
          recipient: "sender@example.test",
          reconnectUrl: "https://recurmail.example.test/dashboard?gmail=failed",
        },
      ],
      "reconnect email outbox request",
    );
    equal(store.completed, [], "invalid_grant is not completed as a send");
  } finally {
    await fake.close();
  }
});

Deno.test("invalid_grant avoids sending later claims for the same account", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const second = { ...dueSchedule(envelope), schedule_id: "schedule-2" };
  const store = recordingStore([dueSchedule(envelope), second]);
  let sends = 0;
  const result = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    send: async () => {
      sends += 1;
      throw new GmailError("invalid_grant", "invalid_grant");
    },
  });
  equal(sends, 1, "second claim for the disconnected account is not sent");
  equal(result.failed, 2, "both claimed schedules are marked failed");
  equal(
    store.reconnects.length,
    2,
    "each claimed schedule gets a failed log through reconnect RPC",
  );
  equal(
    store.reconnects.map(
      (row) => (row as { connectionId: string }).connectionId,
    ),
    ["connection-1", "connection-1"],
    "both reconnect rows name the rejected account",
  );
});

Deno.test("invalid_grant on one account leaves the user's other account sending", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const work = {
    ...dueSchedule(envelope),
    schedule_id: "schedule-work",
    gmail_connection_id: "connection-work",
    google_email: "work@company.test",
  };
  const personalAgain = {
    ...dueSchedule(envelope),
    schedule_id: "schedule-personal-2",
  };
  const schedules = [dueSchedule(envelope), work, personalAgain];
  const store = recordingStore(schedules);
  const sentFrom: string[] = [];
  const result = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    // The sender only sees the Gmail fields, so the account is told apart by
    // its address: sender@example.test is connection-1.
    send: async (schedule) => {
      if (schedule.google_email === "sender@example.test") {
        throw new GmailError("invalid_grant", "invalid_grant");
      }
      sentFrom.push(schedule.google_email);
      return `message-${schedule.google_email}`;
    },
  });
  equal(
    result,
    {
      claimed: 3,
      sent: 1,
      failed: 2,
      deferred: 0,
      notices_sent: 0,
      notices_failed: 0,
    },
    "the healthy account sends while the rejected one fails",
  );
  equal(
    sentFrom,
    ["work@company.test"],
    "the send came from the other account",
  );
  equal(
    store.completed.map((row) => (row as { scheduleId: string }).scheduleId),
    ["schedule-work"],
    "only the other account's schedule is completed as sent",
  );
  equal(
    store.reconnects.map((row) => {
      const value = row as { scheduleId: string; connectionId: string };
      return [value.scheduleId, value.connectionId];
    }),
    [
      ["schedule-1", "connection-1"],
      ["schedule-personal-2", "connection-1"],
    ],
    "only the rejected account's schedules are marked for reconnect",
  );
});

Deno.test("Gmail 5xx send outcomes are failed and never retried", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const fake = await fakeGoogleServer(503);
  const store = recordingStore([dueSchedule(envelope)]);
  const fakeFetch: typeof fetch = (input, init) => {
    const original = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return fetch(
      `${fake.url}${
        original.pathname === "/token"
          ? "/token"
          : "/gmail/v1/users/me/messages/send"
      }`,
      init,
    );
  };
  try {
    await runSender(store, {
      key,
      clientId: "fake",
      clientSecret: "fake",
      appUrl: "https://recurmail.example.test",
      fetcher: fakeFetch,
    });
  } finally {
    await fake.close();
  }
  equal(
    store.completed,
    [
      {
        scheduleId: "schedule-1",
        scheduledFor: "2026-10-14T17:00:00.000Z",
        status: "failed",
        nextSendAt: "2026-10-15T17:00:00.000Z",
        errorCode: "gmail_503",
      },
    ],
    "failed send_log row advances without retrying the occurrence",
  );
});

Deno.test("Gmail send timeouts are failed and never retried", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const store = recordingStore([dueSchedule(envelope)]);
  let gmailPosts = 0;
  const timeoutFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.pathname === "/token") {
      return Response.json({ access_token: "fake-access" });
    }
    gmailPosts += 1;
    assert(
      typeof init?.body === "string",
      "Gmail send body was dispatched before timeout",
    );
    throw new TypeError("socket timed out after request body dispatch");
  };
  await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    fetcher: timeoutFetch,
  });
  equal(gmailPosts, 1, "one Gmail send request");
  equal(
    store.completed,
    [
      {
        scheduleId: "schedule-1",
        scheduledFor: "2026-10-14T17:00:00.000Z",
        status: "failed",
        nextSendAt: "2026-10-15T17:00:00.000Z",
        errorCode: "gmail_send_outcome_unknown",
      },
    ],
    "timeout send_log row advances without retrying the occurrence",
  );
});

Deno.test("stale claims are failed and advanced without another Gmail send", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const stale = dueSchedule(envelope);
  const store = recordingStore([]);
  store.reclaimed.push(stale);
  let sends = 0;
  const result = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    now: () => new Date("2026-10-14T18:00:00.000Z"),
    send: async () => {
      sends += 1;
      return "should-not-send";
    },
  });
  equal(sends, 0, "a stale claim is not sent again");
  equal(
    store.completed,
    [
      {
        scheduleId: "schedule-1",
        scheduledFor: "2026-10-14T17:00:00.000Z",
        status: "failed",
        nextSendAt: "2026-10-15T17:00:00.000Z",
        errorCode: "claim_expired",
      },
    ],
    "stale occurrence is failed and advanced",
  );
  equal(result.failed, 1, "stale claim is counted as failed");
  equal(store.heartbeats.length, 1, "recovery writes a heartbeat");
});

Deno.test("one completion store failure does not stop later schedules or heartbeat", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const schedules = [
    dueSchedule(envelope),
    { ...dueSchedule(envelope), schedule_id: "schedule-2" },
    { ...dueSchedule(envelope), schedule_id: "schedule-3" },
  ];
  const store = recordingStore(schedules);
  store.complete = async (value) => {
    if (value.scheduleId === "schedule-1") {
      throw new Error("database connection dropped");
    }
    store.completed.push(value);
  };
  let messageNumber = 0;
  const result = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    send: async () => {
      messageNumber += 1;
      return `message-${messageNumber}`;
    },
  });
  equal(
    result,
    {
      claimed: 3,
      sent: 2,
      failed: 1,
      deferred: 0,
      notices_sent: 0,
      notices_failed: 0,
    },
    "batch totals",
  );
  equal(
    store.completed.map((row) => (row as { scheduleId: string }).scheduleId),
    ["schedule-2", "schedule-3"],
    "later schedules are completed after the first store failure",
  );
  equal(
    store.failureLogs,
    [
      {
        scheduleId: "schedule-1",
        scheduledFor: "2026-10-14T17:00:00.000Z",
        errorCode: "post_send_store_failed",
      },
    ],
    "the accepted message is logged with its distinct store failure code",
  );
  equal(
    store.heartbeats.length,
    1,
    "heartbeat is written despite a store failure",
  );
});

Deno.test("a reconnect store failure does not stop later schedules or heartbeat", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const schedules = [
    dueSchedule(envelope),
    { ...dueSchedule(envelope), schedule_id: "schedule-2" },
    { ...dueSchedule(envelope), schedule_id: "schedule-3" },
  ];
  const store = recordingStore(schedules);
  store.reconnect = async (value) => {
    store.reconnects.push(value);
    if (value.scheduleId === "schedule-1") {
      throw new Error("outbox database connection dropped");
    }
  };
  let sends = 0;
  const result = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    send: async () => {
      sends += 1;
      throw new GmailError("invalid_grant", "invalid_grant");
    },
  });
  equal(
    result,
    {
      claimed: 3,
      sent: 0,
      failed: 3,
      deferred: 0,
      notices_sent: 0,
      notices_failed: 0,
    },
    "reconnect batch totals",
  );
  equal(sends, 1, "the disconnected account is not sent again");
  equal(
    store.reconnects.length,
    3,
    "the batch continues processing reconnect rows",
  );
  equal(
    store.heartbeats.length,
    1,
    "heartbeat is written after reconnect store failure",
  );
});

Deno.test("post-send DB failure is logged and a later run reclaims without resending", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const stale = dueSchedule(envelope);
  const store = recordingStore([stale]);
  let allowRecovery = false;
  store.reclaimStaleSending = async () => (allowRecovery ? [stale] : []);
  store.claim = async () => (allowRecovery ? [] : [stale]);
  store.complete = async (value) => {
    if (value.status === "sent") {
      throw new Error("database write failed after Gmail accepted");
    }
    store.completed.push(value);
  };
  let sends = 0;
  const first = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    send: async () => {
      sends += 1;
      return "accepted-message";
    },
  });
  equal(first.failed, 1, "post-send DB failure is counted as failed");
  equal(
    store.failureLogs[0],
    {
      scheduleId: "schedule-1",
      scheduledFor: "2026-10-14T17:00:00.000Z",
      errorCode: "post_send_store_failed",
    },
    "post-send failure keeps a distinct log code",
  );

  allowRecovery = true;
  store.completed.length = 0;
  const second = await runSender(store, {
    key,
    clientId: "fake",
    clientSecret: "fake",
    appUrl: "https://recurmail.example.test",
    now: () => new Date("2026-10-14T18:00:00.000Z"),
    send: async () => {
      sends += 1;
      return "duplicate-send-forbidden";
    },
  });
  equal(sends, 1, "a recovered accepted message is never sent again");
  equal(second.failed, 1, "recovery accounts for the unknown outcome");
  equal(
    store.completed[0],
    {
      scheduleId: "schedule-1",
      scheduledFor: "2026-10-14T17:00:00.000Z",
      status: "failed",
      nextSendAt: "2026-10-15T17:00:00.000Z",
      errorCode: "claim_expired",
    },
    "the later run advances the still-sending schedule",
  );
});

function noticeStore() {
  const store = recordingStore([]) as SenderStore & {
    claimReconnectNotices: (limit: number) => Promise<
      {
        id: string;
        recipient: string;
        reconnect_url: string;
        attempts: number;
      }[]
    >;
    markReconnectNoticeSent: (id: string) => Promise<void>;
    markReconnectNoticeFailed: (id: string, errorCode: string) => Promise<void>;
    heartbeats: unknown[];
  };
  const state = {
    queue: [
      {
        id: "notice-1",
        recipient: "user@example.test",
        reconnect_url: "https://recurmail.example.test/reconnect?x=1&y=<z>",
        attempts: 0,
        status: "queued",
      },
    ],
    sent: [] as string[],
    failures: [] as { id: string; errorCode: string }[],
    claims: 0,
  };
  store.claimReconnectNotices = async (limit: number) => {
    assert(limit === 20, "notice claim is capped at 20");
    state.claims += 1;
    return state.queue.flatMap((row) => {
      if (row.status !== "queued" || row.attempts >= 3) return [];
      row.status = "sending";
      row.attempts += 1;
      return [{ ...row }];
    });
  };
  store.markReconnectNoticeSent = async (id: string) => {
    state.sent.push(id);
    const row = state.queue.find((item) => item.id === id);
    if (row) row.status = "sent";
  };
  store.markReconnectNoticeFailed = async (id: string, errorCode: string) => {
    state.failures.push({ id, errorCode });
    const row = state.queue.find((item) => item.id === id);
    if (row) row.status = row.attempts >= 3 ? "failed" : "queued";
  };
  return { store, state };
}

async function fakeResend(statuses: number[]) {
  type Payload = { subject: string; text: string; html: string };
  const requests: { authorization: string | null; body: Payload }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as Payload,
      });
      const status =
        statuses[Math.min(requests.length - 1, statuses.length - 1)];
      return new Response(
        status >= 200 && status < 300
          ? JSON.stringify({ id: "resend-id" })
          : "provider error",
        { status },
      );
    },
  );
  const address = server.addr as Deno.NetAddr;
  return {
    endpoint: `http://${address.hostname}:${address.port}/emails`,
    requests,
    close: () => server.shutdown(),
  };
}

const noticeConfig = (endpoint: string, key = "resend-test-key") => ({
  key: "unused",
  clientId: "unused",
  clientSecret: "unused",
  appUrl: "https://recurmail.example.test",
  resendApiKey: key,
  reconnectEmailFrom: "RecurMail <notices@example.test>",
  resendEndpoint: endpoint,
});

Deno.test("Resend 2xx marks a reconnect notice sent and escapes its HTML link", async () => {
  const { store, state } = noticeStore();
  const server = await fakeResend([202]);
  try {
    const result = await runSender(store, noticeConfig(server.endpoint));
    equal(result.notices_sent, 1, "sent notice count");
    equal(state.sent, ["notice-1"], "notice persisted as sent");
    equal(
      server.requests[0].authorization,
      "Bearer resend-test-key",
      "Resend authorization",
    );
    equal(
      server.requests[0].body.subject,
      "Reconnect Gmail to keep your RecurMail schedules running",
      "subject",
    );
    assert(
      server.requests[0].body.text.includes(
        "https://recurmail.example.test/reconnect?x=1&y=<z>",
      ),
      "plain text includes the reconnect link",
    );
    assert(
      server.requests[0].body.html.includes("&amp;") &&
        server.requests[0].body.html.includes("&lt;z&gt;"),
      "HTML link is escaped",
    );
    equal(
      store.heartbeats[0],
      {
        id: (store.heartbeats[0] as { id: string }).id,
        startedAt: (store.heartbeats[0] as { startedAt: string }).startedAt,
        finishedAt: (store.heartbeats[0] as { finishedAt: string }).finishedAt,
        claimed: 0,
        sent: 0,
        failed: 0,
        deferred: 0,
        noticesSent: 1,
        noticesFailed: 0,
        failureRateLastHour: 0.1,
        failedLastHour: 2,
        attemptedLastHour: 20,
      },
      "heartbeat records notice delivery counts",
    );
  } finally {
    await server.close();
  }
});

Deno.test("Resend 4xx and 5xx failures increment attempts and stop after three total tries", async () => {
  const { store, state } = noticeStore();
  const server = await fakeResend([400, 503, 500]);
  try {
    for (let index = 0; index < 3; index += 1) {
      await runSender(store, noticeConfig(server.endpoint));
      state.failures.length = index + 1;
    }
    equal(server.requests.length, 3, "three total HTTP attempts");
    equal(state.queue[0].attempts, 3, "attempts increment on each claim");
    equal(
      state.queue[0].status,
      "failed",
      "third failure leaves the notice failed",
    );
    equal(
      state.failures.map((failure) => failure.errorCode),
      ["resend_http_400", "resend_http_503", "resend_http_500"],
      "safe status error codes",
    );
    await runSender(store, noticeConfig(server.endpoint));
    equal(server.requests.length, 3, "no fourth attempt");
  } finally {
    await server.close();
  }
});

Deno.test("missing Resend key leaves notices queued while schedule sends continue", async () => {
  const { envelope, key } = await nodeEncryptedToken();
  const { store, state } = noticeStore();
  store.claim = async () => [dueSchedule(envelope)];
  let scheduleSends = 0;
  const result = await runSender(store, {
    ...noticeConfig("http://127.0.0.1:1/emails", ""),
    key,
    clientId: "fake",
    clientSecret: "fake",
    send: async () => {
      scheduleSends += 1;
      return "gmail-accepted";
    },
  });
  equal(scheduleSends, 1, "scheduled email still sent");
  equal(state.queue[0].status, "queued", "notice remains queued");
  equal(state.claims, 0, "outbox is not claimed without API key");
  equal(result.notices_sent, 0, "notice count remains zero");
});
