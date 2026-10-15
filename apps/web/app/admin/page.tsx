import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { loadAdminMetrics } from "../../lib/admin-metrics";

export const dynamic = "force-dynamic";

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

export default async function AdminPage() {
  const request = new Request("https://recurmail.com/admin", {
    headers: await headers(),
  });
  const metrics = await loadAdminMetrics(request);
  if (!metrics) notFound();

  return (
    <main>
      <h1>RecurMail admin</h1>
      <dl>
        <dt>Signed-up users</dt>
        <dd>{metrics.signed_up_users}</dd>
        <dt>Connected Gmail accounts</dt>
        <dd>{metrics.connected_gmail_accounts}</dd>
        <dt>Active schedules</dt>
        <dd>{metrics.active_schedules}</dd>
        <dt>Sends in the last 24 hours</dt>
        <dd>{metrics.sends_last_24_hours}</dd>
        <dt>Failed sends in the last hour</dt>
        <dd>
          {metrics.failed_last_hour} / {metrics.attempted_last_hour} (
          {percent(metrics.failure_rate_last_hour)})
        </dd>
        <dt>Users whose schedules kept sending for 30 days</dt>
        <dd>{metrics.kept_sending_30_days}</dd>
      </dl>
      <p>
        “Kept sending for 30 days” counts distinct users with an active schedule
        created at least 30 days ago and at least one send marked sent in the
        last 7 days.
      </p>
    </main>
  );
}
