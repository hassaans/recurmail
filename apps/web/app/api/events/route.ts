import { runEventsRoute } from "../../../lib/runtime";

export const runtime = "nodejs";

export function POST(request: Request) {
  return runEventsRoute(request);
}
