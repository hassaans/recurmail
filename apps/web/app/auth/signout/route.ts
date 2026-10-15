import { runRoute } from "../../../lib/runtime";
export const runtime = "nodejs";
export function POST(request: Request) {
  return runRoute("signout", request);
}
