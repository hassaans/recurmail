import { runTestSendRoute } from "../../../../lib/runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return runTestSendRoute(request);
}
