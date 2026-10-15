import { createSenderHandler } from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("cron handler rejects a missing shared secret", async () => {
  let executions = 0;
  const handler = createSenderHandler({
    getCronSecret: () => "expected-cron-secret",
    execute: async () => {
      executions += 1;
      return { claimed: 0, sent: 0, failed: 0, deferred: 0 };
    },
  });
  const missing = await handler(
    new Request("http://local/send-due", { method: "POST" }),
  );
  assert(missing.status === 401, `missing secret returned ${missing.status}`);
  assert(executions === 0, `missing secret executed ${executions} times`);
});

Deno.test("cron handler rejects an incorrect shared secret", async () => {
  let executions = 0;
  const handler = createSenderHandler({
    getCronSecret: () => "expected-cron-secret",
    execute: async () => {
      executions += 1;
      return { claimed: 0, sent: 0, failed: 0, deferred: 0 };
    },
  });
  const incorrect = await handler(
    new Request("http://local/send-due", {
      method: "POST",
      headers: { "x-recurmail-cron-secret": "wrong-secret" },
    }),
  );
  assert(
    incorrect.status === 401,
    `incorrect secret returned ${incorrect.status}`,
  );
  assert(executions === 0, `incorrect secret executed ${executions} times`);
});

Deno.test("cron handler runs sender only with the correct shared secret", async () => {
  let executions = 0;
  const handler = createSenderHandler({
    getCronSecret: () => "expected-cron-secret",
    execute: async () => {
      executions += 1;
      return { claimed: 2, sent: 2, failed: 0, deferred: 0 };
    },
  });
  const response = await handler(
    new Request("http://local/send-due", {
      method: "POST",
      headers: { "x-recurmail-cron-secret": "expected-cron-secret" },
    }),
  );
  assert(
    response.status === 200,
    `authorized request returned ${response.status}`,
  );
  assert(executions === 1, `authorized request executed ${executions} times`);
  const body = await response.json();
  assert(body.sent === 2, `authorized request sent ${body.sent} schedules`);
});

Deno.test("cron handler fails closed when the secret is not configured", async () => {
  let executions = 0;
  const handler = createSenderHandler({
    getCronSecret: () => undefined,
    execute: async () => {
      executions += 1;
      return { claimed: 0, sent: 0, failed: 0, deferred: 0 };
    },
  });
  const response = await handler(
    new Request("http://local/send-due", {
      method: "POST",
      headers: { "x-recurmail-cron-secret": "unexpected-config" },
    }),
  );
  assert(
    response.status === 500,
    `missing configuration returned ${response.status}`,
  );
  assert(executions === 0, "missing configuration does not run the sender");
});
