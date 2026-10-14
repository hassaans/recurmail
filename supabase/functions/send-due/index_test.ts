import { decryptRefreshToken } from "./crypto.ts";
import { type ClaimedSchedule, runSender, type SenderStore } from "./engine.ts";
import { GmailError } from "./gmail.ts";

Deno.chdir(new URL("../../..", import.meta.url));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function nodeEncryptedToken(): Promise<{
  envelope: string;
  key: string;
  owner: string;
}> {
  const owner = "user-interop-1";
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const script = `import { encryptRefreshToken } from './apps/web/lib/crypto.ts'; console.log(encryptRefreshToken('refresh-token-from-node', ${JSON.stringify(key)}, ${JSON.stringify(owner)}));`;
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
} {
  const state = {
    completed: [] as unknown[],
    reconnects: [] as unknown[],
    heartbeats: [] as unknown[],
  };
  return {
    ...state,
    async claim() {
      return schedules;
    },
    async complete(value) {
      state.completed.push(value);
    },
    async reconnect(value) {
      state.reconnects.push(value);
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
        if (tokenError)
          return Response.json({ error: tokenError }, { status: 400 });
        return Response.json({
          access_token: "fake-access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (
        new URL(request.url).pathname === "/gmail/v1/users/me/messages/send"
      ) {
        if (gmailStatus !== 200)
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
      { claimed: 1, sent: 1, failed: 0, deferred: 0 },
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
      `${fake.url}${original.pathname === "/token" ? "/token" : "/gmail/v1/users/me/messages/send"}`,
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
      `${fake.url}${original.pathname === "/token" ? "/token" : "/gmail/v1/users/me/messages/send"}`,
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

Deno.test("invalid_grant avoids sending later claims for the same user", async () => {
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
  equal(sends, 1, "second claim for disconnected user is not sent");
  equal(result.failed, 2, "both claimed schedules are marked failed");
  equal(
    store.reconnects.length,
    2,
    "each claimed schedule gets a failed log through reconnect RPC",
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
      `${fake.url}${original.pathname === "/token" ? "/token" : "/gmail/v1/users/me/messages/send"}`,
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
    if (url.pathname === "/token")
      return Response.json({ access_token: "fake-access" });
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
