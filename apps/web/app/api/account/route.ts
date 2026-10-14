import { runAccountRoute } from "../../../lib/runtime";

export async function POST(request: Request) {
  return runAccountRoute(request);
}
