import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import AppShell from "../../../../components/AppShell";
import controls from "../../../../components/controls.module.css";
import ScheduleHistory from "../../../../components/ScheduleHistory";
import { configuredRuntime } from "../../../../lib/runtime";
import type { ScheduleRow, SendHistoryRow } from "../../../../lib/schedules";

export const metadata = {
  title: "Send history | RecurMail",
  robots: { index: false, follow: false },
};

export default async function ScheduleHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const runtime = configuredRuntime();
  const requestHeaders = await headers();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://schedules.internal", { headers: requestHeaders }),
      )
    : { kind: "signed_out" as const };
  if (!runtime || state.kind !== "signed_in") redirect("/dashboard");
  const connectionStatus =
    state.connection?.status === "connected" ||
    state.connection?.status === "needs_reconnect"
      ? state.connection.status
      : "disconnected";

  const apiRequest = (path: string) =>
    new Request(`http://schedules.internal${path}`, {
      headers: requestHeaders,
    });
  const [scheduleResponse, historyResponse] = await Promise.all([
    runtime.schedules.get(apiRequest(`/api/schedules/${id}`), id),
    runtime.schedules.history(apiRequest(`/api/schedules/${id}/history`), id),
  ]);
  if (scheduleResponse.status === 404 || historyResponse.status === 404)
    notFound();

  let schedule: ScheduleRow | null = null;
  let history: SendHistoryRow[] = [];
  if (scheduleResponse.ok && historyResponse.ok) {
    const [scheduleResult, historyResult] = (await Promise.all([
      scheduleResponse.json(),
      historyResponse.json(),
    ])) as [{ schedule?: ScheduleRow }, { history?: SendHistoryRow[] }];
    schedule = scheduleResult.schedule ?? null;
    history = historyResult.history ?? [];
  } else {
    console.error(
      "[ERROR] schedule_history_load_failed",
      scheduleResponse.status,
      historyResponse.status,
    );
  }

  return (
    <AppShell email={state.user.email} active="schedules">
      {schedule ? (
        <ScheduleHistory
          schedule={schedule}
          history={history}
          connectionStatus={connectionStatus}
        />
      ) : (
        <p className={controls.error} role="alert">
          Send history could not be loaded. Refresh to try again.
        </p>
      )}
    </AppShell>
  );
}
