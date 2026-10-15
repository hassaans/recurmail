import { runScheduleRoute } from "../../../lib/runtime";

export const runtime = "nodejs";

export function GET(request: Request) {
  return runScheduleRoute("list", request);
}

export function POST(request: Request) {
  return runScheduleRoute("create", request);
}
