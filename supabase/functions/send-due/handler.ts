export type SenderHandlerOptions = {
  getCronSecret: () => string | undefined;
  execute: (request: {
    source: string | null;
  }) => Promise<Record<string, number | string>>;
};

export function createSenderHandler(options: SenderHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const expected = options.getCronSecret()?.trim();
    if (!expected) {
      console.error("send-due configuration missing", {
        errorCode: "cron_secret_missing",
      });
      return Response.json(
        { error: "sender_configuration_error" },
        { status: 500 },
      );
    }
    const provided = request.headers.get("x-recurmail-cron-secret");
    if (!provided || !(await constantTimeEqual(provided, expected)))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      return Response.json(
        await options.execute({ source: await requestSource(request) }),
      );
    } catch (error) {
      console.error("send-due failed", error);
      return Response.json({ error: "sender_failed" }, { status: 500 });
    }
  };
}

async function requestSource(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "source" in body) {
      const { source } = body as { source: unknown };
      if (typeof source === "string") return source;
    }
  } catch {
    // A missing or malformed body still runs the sender.
  }
  return null;
}

async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(left)),
  );
  const rightDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(right)),
  );
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1)
    difference |= leftDigest[index] ^ rightDigest[index];
  return difference === 0;
}
