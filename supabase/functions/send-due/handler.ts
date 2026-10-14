export type SenderHandlerOptions = {
  getCronSecret: () => string | undefined;
  execute: () => Promise<Record<string, number | string>>;
};

export function createSenderHandler(options: SenderHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    try {
      return Response.json(await options.execute());
    } catch (error) {
      console.error("send-due failed", error);
      return Response.json({ error: "sender_failed" }, { status: 500 });
    }
  };
}
