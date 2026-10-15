import { runScheduleRoute } from "../../../../../lib/runtime";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return runScheduleRoute("history", request, id);
}
