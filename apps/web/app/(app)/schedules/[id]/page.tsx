import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ScheduleDetail from "../../../../components/ScheduleDetail";
import { configuredRuntime } from "../../../../lib/runtime";

export const metadata = {
  title: "Send history | RecurMail",
  robots: { index: false, follow: false },
};

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runtime = configuredRuntime();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://schedules.internal", { headers: await headers() }),
      )
    : { kind: "signed_out" as const };
  if (state.kind !== "signed_in") redirect("/dashboard");
  return <ScheduleDetail id={id} />;
}
