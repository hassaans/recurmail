import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  type AnalyticsSummary,
  FUNNEL_STEPS,
  loadAcquisition,
  loadAdminMetrics,
} from "../../lib/admin-metrics";

export const dynamic = "force-dynamic";

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const rate = (part: number, whole: number) =>
  whole === 0 ? "–" : percent(part / whole);

const stepLabels: Record<(typeof FUNNEL_STEPS)[number], string> = {
  page_view: "Visited",
  signup_started: "Started sign-up",
  signup_completed: "Signed up",
  gmail_connected: "Connected Gmail",
  schedule_created: "Created a schedule",
};

function Acquisition({ summary }: { summary: AnalyticsSummary }) {
  const first = summary.funnel.page_view;
  return (
    <section aria-labelledby={`acquisition-${summary.days}`}>
      <h3 id={`acquisition-${summary.days}`}>Last {summary.days} days</h3>
      <dl>
        <dt>Unique visitors</dt>
        <dd>{summary.visitors}</dd>
        <dt>Sign-ups</dt>
        <dd>
          {summary.signups} ({rate(summary.signups, summary.visitors)} of
          visitors)
        </dd>
      </dl>
      <h4>Funnel</h4>
      <table>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">People</th>
            <th scope="col">Of visitors</th>
            <th scope="col">Of previous step</th>
          </tr>
        </thead>
        <tbody>
          {FUNNEL_STEPS.map((step, index) => {
            const previous =
              index === 0 ? first : summary.funnel[FUNNEL_STEPS[index - 1]];
            return (
              <tr key={step}>
                <th scope="row">{stepLabels[step]}</th>
                <td>{summary.funnel[step]}</td>
                <td>{rate(summary.funnel[step], first)}</td>
                <td>
                  {index === 0 ? "–" : rate(summary.funnel[step], previous)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h4>Sources</h4>
      {summary.sources.length === 0 ? (
        <p>No visits recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Visitors</th>
              <th scope="col">Sign-ups</th>
              <th scope="col">Sign-up rate</th>
            </tr>
          </thead>
          <tbody>
            {summary.sources.map((row) => (
              <tr key={row.source}>
                <th scope="row">{row.source}</th>
                <td>{row.visitors}</td>
                <td>{row.signups}</td>
                <td>{rate(row.signups, row.visitors)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Top landing pages</h4>
      {summary.landing_paths.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <ol>
          {summary.landing_paths.map((row) => (
            <li key={row.path}>
              {row.path} — {row.visitors}
            </li>
          ))}
        </ol>
      )}
      <h4>Top referrers</h4>
      {summary.referrers.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <ol>
          {summary.referrers.map((row) => (
            <li key={row.host}>
              {row.host} — {row.visitors}
            </li>
          ))}
        </ol>
      )}
      <h4>Events</h4>
      {summary.events.length === 0 ? (
        <p>None yet.</p>
      ) : (
        <ul>
          {summary.events.map((row) => (
            <li key={row.event}>
              {row.event} — {row.count}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AdminPage() {
  const request = new Request("https://recurmail.com/admin", {
    headers: await headers(),
  });
  const metrics = await loadAdminMetrics(request);
  if (!metrics) notFound();
  const acquisition = await loadAcquisition([7, 30]);

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
      <h2>Acquisition</h2>
      {acquisition ? (
        acquisition.map((summary) => (
          <Acquisition key={summary.days} summary={summary} />
        ))
      ) : (
        <p>Acquisition data is unavailable right now.</p>
      )}
      <p>
        A visitor is a browser that viewed a page. The funnel counts distinct
        people: the browser where known, otherwise the account. Sources come
        from the first page view in the window and from each sign-up's first
        visit.
      </p>
    </main>
  );
}
