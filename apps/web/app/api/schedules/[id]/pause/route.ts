import { runScheduleRoute } from "../../../../../lib/runtime";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runScheduleRoute("pause", request, id);
}
