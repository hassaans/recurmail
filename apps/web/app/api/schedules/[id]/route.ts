import { runScheduleRoute } from "../../../../lib/runtime";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return runScheduleRoute("get", request, id);
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return runScheduleRoute("patch", request, id);
}

export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;
  return runScheduleRoute("delete", request, id);
}
