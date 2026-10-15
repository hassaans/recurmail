import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import AppShell from "../../../../../components/AppShell";
import ScheduleEditor from "../../../../../components/ScheduleEditor";
import { configuredRuntime } from "../../../../../lib/runtime";

export const metadata = {
  title: "Edit schedule | RecurMail",
  robots: { index: false, follow: false },
};

export default async function EditSchedulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const runtime = configuredRuntime();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://schedules.internal", { headers: await headers() }),
      )
    : { kind: "signed_out" as const };
  if (state.kind !== "signed_in" || state.connection?.status !== "connected")
    redirect("/dashboard");
  return (
    <AppShell email={state.user.email} active="schedules">
      <ScheduleEditor
        scheduleId={id}
        userEmail={state.user.email}
        senderEmail={state.connection?.google_email ?? null}
      />
    </AppShell>
  );
}
