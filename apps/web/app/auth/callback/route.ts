import { runRoute } from "../../../lib/runtime";
export const runtime = "nodejs";
export function GET(request: Request) {
  return runRoute("authCallback", request);
}
