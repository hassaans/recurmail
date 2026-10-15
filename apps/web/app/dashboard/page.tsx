import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "../../components/AppShell";
import ConfirmForm from "../../components/ConfirmForm";
import controls from "../../components/controls.module.css";
import ScheduleList from "../../components/ScheduleList";
import { configuredRuntime } from "../../lib/runtime";
import {
  type ScheduleSummary,
  summarizeSchedule,
} from "../../lib/schedule-summary";
import type { ScheduleRow } from "../../lib/schedules";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Your schedules | RecurMail",
  robots: { index: false, follow: false },
};

const gmailMessages: Record<string, string> = {
  denied:
    "Gmail permission was declined. RecurMail needs permission to send your scheduled emails. It cannot read your inbox. You can try again when you are ready.",
  failed:
    "Gmail could not be connected. Please try again and use the same Google account you used to sign in.",
  connected: "Gmail is connected. RecurMail can send your scheduled emails.",
  disconnected: "Gmail is disconnected. All your schedules are paused.",
  disconnect_failed:
    "Disconnect could not finish. Please try again. Your Gmail connection will stay here until Google revocation and removal are complete.",
};

type SearchParams = {
  gmail?: string;
  auth?: string;
  warning?: string;
  saved?: string;
};

const disconnectDialog = {
  title: "Disconnect Gmail?",
  description:
    "RecurMail will give up its permission to send from this Gmail account and pause every schedule. You can connect again at any time.",
  confirmLabel: "Disconnect Gmail",
  action: "/api/gmail/disconnect",
} as const;

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const runtime = configuredRuntime();
  const requestHeaders = await headers();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://dashboard.internal", { headers: requestHeaders }),
      )
    : { kind: "signed_out" as const };
  if (state.kind === "refresh") redirect("/auth/refresh");
  const user = state.kind === "signed_in" ? state.user : null;
  const connection = state.kind === "signed_in" ? state.connection : null;
  const connectionStatus =
    connection?.status === "connected" ||
    connection?.status === "needs_reconnect"
      ? connection.status
      : "disconnected";
  const connected = connectionStatus === "connected";

  let schedules: ScheduleSummary[] = [];
  let loadError = false;
  if (user && runtime) {
    const response = await runtime.schedules.list(
      new Request("http://dashboard.internal/api/schedules", {
        headers: requestHeaders,
      }),
    );
    if (response.ok) {
      const result = (await response.json()) as { schedules?: ScheduleRow[] };
      schedules = (result.schedules ?? []).map(summarizeSchedule);
    } else {
      console.error("[ERROR] dashboard_schedules_list_failed", response.status);
      loadError = true;
    }
  }

  const notices: string[] = [];
  const gmailMessage = params.gmail ? gmailMessages[params.gmail] : undefined;
  if (gmailMessage) notices.push(gmailMessage);
  if (params.auth === "failed")
    notices.push("Google sign-in could not finish. Please try again.");
  if (params.saved === "1") notices.push("Schedule saved.");
  if (params.warning) notices.push(params.warning);
  const unavailable =
    state.kind === "unavailable" || params.auth === "unavailable";

  return (
    <AppShell email={user?.email} active="schedules">
      {user ? (
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Send from your own Gmail</p>
            <h1>Your schedules</h1>
          </div>
          <div className={styles.headerActions}>
            {connected ? (
              <a className={controls.primary} href="/schedules/new">
                New schedule
              </a>
            ) : (
              <>
                <button
                  className={controls.primary}
                  type="button"
                  disabled
                  aria-describedby="new-schedule-hint"
                >
                  New schedule
                </button>
                <p id="new-schedule-hint" className={styles.hint}>
                  {connectionStatus === "needs_reconnect"
                    ? "Reconnect Gmail to create new schedules."
                    : "Connect Gmail first. Schedules send from your own Gmail account."}
                </p>
              </>
            )}
          </div>
        </header>
      ) : (
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.eyebrow}>Send from your own Gmail</p>
            <h1>Sign in to RecurMail</h1>
          </div>
        </header>
      )}
      {notices.length ? (
        <div className={styles.status} role="status">
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      ) : null}
      {unavailable ? (
        <p className={controls.error} role="alert">
          Your connection is unavailable right now. Please try again later.
        </p>
      ) : null}

      {!user ? (
        <section
          className={`${controls.card} ${styles.signIn}`}
          aria-label="Sign in"
        >
          <p>
            Sign in with Google, then connect that same account to send
            scheduled emails from your own Gmail.
          </p>
          <a className={controls.primary} href="/auth/signin">
            Sign in with Google
          </a>
        </section>
      ) : null}

      {user && connection && connectionStatus === "needs_reconnect" ? (
        <section className={styles.reconnect} aria-label="Gmail account">
          <div className={styles.banner} role="alert">
            <p>
              <strong>Gmail needs reconnecting</strong>
              Your Gmail permission needs renewing. Reconnect Gmail to resume
              your scheduled emails.
            </p>
            <form
              className={styles.form}
              method="post"
              action="/api/gmail/connect"
            >
              <button className={controls.primary} type="submit">
                Reconnect Gmail
              </button>
            </form>
          </div>
          <div className={styles.reconnectMeta}>
            <p>
              Connected account:{" "}
              <span className={styles.email}>{connection.google_email}</span>
            </p>
            <ConfirmForm
              trigger="Disconnect"
              triggerStyle="dangerQuiet"
              tone="danger"
              {...disconnectDialog}
            />
          </div>
        </section>
      ) : null}

      {user && !connected && connectionStatus !== "needs_reconnect" ? (
        <section
          className={`${controls.card} ${styles.step}`}
          aria-label="Gmail account"
        >
          <div className={styles.stepNumber} aria-hidden="true">
            1
          </div>
          <div>
            <h2>Connect Gmail to start sending</h2>
            <p>
              Connect the same Google account you used to sign in. RecurMail
              sends every schedule from that address, so recipients see your
              normal Gmail sender.
            </p>
            <div className={styles.reassurance}>
              <svg viewBox="0 0 20 20" aria-hidden="true" fill="none">
                <path
                  d="M10 2.5 4 5v4.5c0 3.6 2.6 6.6 6 7.5 3.4-.9 6-3.9 6-7.5V5l-6-2.5Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="m7.3 10.2 1.9 1.9 3.6-3.8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>
                RecurMail asks only for permission to send email. It cannot read
                your inbox, drafts or contacts.
              </span>
            </div>
            <form method="post" action="/api/gmail/connect">
              <button className={controls.primary} type="submit">
                {params.gmail === "denied"
                  ? "Try connecting Gmail again"
                  : "Connect Gmail"}
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {user && connected && connection ? (
        <div className={styles.grid}>
          <ScheduleList
            initialSchedules={schedules}
            connectionStatus="connected"
            loadError={loadError}
          />
          <aside className={styles.sidebar}>
            <section
              className={`${controls.card} ${styles.connection}`}
              aria-label="Gmail connection"
            >
              <h2>Gmail is connected</h2>
              <p className={styles.from}>
                <span className={styles.dot} aria-hidden="true" />
                <span>
                  Sending from{" "}
                  <span className={styles.email}>
                    {connection.google_email}
                  </span>
                </span>
              </p>
              <p>
                RecurMail can send your scheduled emails. It cannot read your
                inbox, drafts or contacts.
              </p>
              <div className={styles.connectionFooter}>
                <ConfirmForm
                  trigger="Disconnect"
                  triggerStyle="dangerQuiet"
                  tone="danger"
                  {...disconnectDialog}
                />
              </div>
            </section>
          </aside>
        </div>
      ) : null}

      {user && !connected && (schedules.length || loadError) ? (
        <div className={styles.listBelow}>
          <ScheduleList
            initialSchedules={schedules}
            connectionStatus={connectionStatus}
            loadError={loadError}
          />
        </div>
      ) : null}
    </AppShell>
  );
}
