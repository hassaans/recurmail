import { runScheduleRoute } from "../../../../lib/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return runScheduleRoute("pauseAll", request);
}
