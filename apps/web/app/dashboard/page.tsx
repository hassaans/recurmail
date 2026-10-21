import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "../../components/AppShell";
import controls from "../../components/controls.module.css";
import DashboardNotices, {
  type DashboardNotice,
} from "../../components/DashboardNotices";
import GmailAccounts from "../../components/GmailAccounts";
import ScheduleList from "../../components/ScheduleList";
import { MAX_GMAIL_CONNECTIONS } from "../../lib/connections";
import { configuredRuntime } from "../../lib/runtime";
import { finishedInfo } from "../../lib/schedule-finished";
import {
  type ScheduleSummary,
  senderAccounts,
  summarizeSchedule,
} from "../../lib/schedule-summary";
import type { ScheduleRow } from "../../lib/schedules";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Your schedules | RecurMail",
  robots: { index: false, follow: false },
};

// A completed action reads as a success; a declined or failed one as a
// warning. The connect and disconnect routes name the account they acted on.
function gmailMessage(
  status: string,
  email: string | null,
): DashboardNotice | undefined {
  switch (status) {
    case "denied":
      return {
        tone: "warn",
        text: "Gmail permission was declined. RecurMail needs permission to send your scheduled emails. It cannot read your inbox. You can try again when you are ready.",
      };
    case "failed":
      return {
        tone: "warn",
        text: "Gmail could not be connected. Please try again.",
      };
    case "limit":
      return {
        tone: "warn",
        text: `You can connect up to ${MAX_GMAIL_CONNECTIONS} Gmail accounts. Disconnect one to add another.`,
      };
    case "address_in_use":
      return {
        tone: "warn",
        text: email
          ? `${email} is already connected here as a different Google account. Disconnect that one first if you want to replace it.`
          : "That address is already connected here as a different Google account. Disconnect that one first if you want to replace it.",
      };
    case "connected":
      return {
        tone: "success",
        text: email
          ? `Connected ${email}. RecurMail can send your scheduled emails from it.`
          : "Gmail is connected. RecurMail can send your scheduled emails.",
      };
    case "disconnected":
      return {
        tone: "success",
        text: email
          ? `Disconnected ${email}. Its schedules are paused.`
          : "Gmail is disconnected. Its schedules are paused.",
      };
    case "disconnect_failed":
      return {
        tone: "warn",
        text: "Disconnect could not finish. Please try again. The Gmail account will stay here until Google revocation and removal are complete.",
      };
    default:
      return undefined;
  }
}

type SearchParams = {
  gmail?: string;
  email?: string;
  auth?: string;
  warning?: string;
  saved?: string;
};

// The notice repeats the address the server put in the redirect. Anything
// that does not look like one is dropped rather than echoed.
function noticeEmail(value: string | undefined): string | null {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? value
    : null;
}

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
  const connections = state.kind === "signed_in" ? state.connections : [];
  const accounts = senderAccounts(connections);
  const connected = connections.some(
    (connection) => connection.status === "connected",
  );
  // Accounts exist but none can send: every one of them needs reconnecting.
  const needsReconnect = connections.length > 0 && !connected;

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
      const now = new Date();
      // Only a finished COUNT schedule needs its send log, to say how many of
      // its sends went out. Everything else is derived from the row itself.
      const sentCount = async (id: string): Promise<number | null> => {
        const history = await runtime.schedules.history(
          new Request(
            `http://dashboard.internal/api/schedules/${encodeURIComponent(id)}/history`,
            { headers: requestHeaders },
          ),
          id,
        );
        if (!history.ok) {
          console.error(
            "[ERROR] dashboard_sent_count_failed",
            id,
            history.status,
          );
          return null;
        }
        const entries = (await history.json()) as {
          history?: { status: string }[];
        };
        return (entries.history ?? []).filter(
          (entry) => entry.status === "sent",
        ).length;
      };
      schedules = await Promise.all(
        (result.schedules ?? []).map(async (row) => {
          const finished = finishedInfo(row, now);
          return summarizeSchedule(
            row,
            finished?.kind === "count"
              ? { ...finished, sent: await sentCount(row.id) }
              : finished,
            accounts,
          );
        }),
      );
    } else {
      console.error("[ERROR] dashboard_schedules_list_failed", response.status);
      loadError = true;
    }
  }

  const notices: DashboardNotice[] = [];
  const gmailNotice = params.gmail
    ? gmailMessage(params.gmail, noticeEmail(params.email))
    : undefined;
  if (gmailNotice) notices.push(gmailNotice);
  if (params.auth === "failed")
    notices.push({
      tone: "warn",
      text: "Google sign-in could not finish. Please try again.",
    });
  if (params.saved === "1")
    notices.push({ tone: "success", text: "Schedule saved." });
  if (params.warning) notices.push({ tone: "warn", text: params.warning });
  const unavailable =
    state.kind === "unavailable" || params.auth === "unavailable";

  return (
    <AppShell email={user?.email} active="schedules">
      {/* Until a Gmail account can send, the Connect or Reconnect card is the
          only call to action, so the New schedule button is not rendered. */}
      {user ? (
        <header className={styles.pageHeader}>
          <div>
            <p className={controls.eyebrow}>Send from your own Gmail</p>
            <h1>Your schedules</h1>
          </div>
          {connected ? (
            <div className={styles.headerActions}>
              <a
                className={controls.primary}
                href="/schedules/new"
                data-track="new_schedule_click"
              >
                New schedule
              </a>
            </div>
          ) : null}
        </header>
      ) : (
        <header className={styles.pageHeader}>
          <div>
            <p className={controls.eyebrow}>Send from your own Gmail</p>
            <h1>Sign in to RecurMail</h1>
          </div>
        </header>
      )}
      {notices.length ? <DashboardNotices notices={notices} /> : null}
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
            Sign in with Google, then connect the Gmail accounts you want to
            send scheduled emails from.
          </p>
          <a
            className={controls.primary}
            href="/auth/signin"
            data-track="cta_click"
            data-track-location="dashboard"
            data-track-label="sign_in_with_google"
            data-track-intent="login"
          >
            Sign in with Google
          </a>
        </section>
      ) : null}

      {user && needsReconnect ? (
        <section className={styles.reconnect} aria-label="Gmail account">
          <div className={styles.banner} role="alert">
            <p>
              <strong>Gmail needs reconnecting</strong>
              {connections.length === 1
                ? "Your Gmail permission needs renewing. Reconnect Gmail, then resume the schedules it paused."
                : "Every Gmail account you connected needs its permission renewed. Reconnect one, then resume the schedules it paused."}
            </p>
            {connections.length === 1 ? (
              <form
                className={styles.form}
                method="post"
                action="/api/gmail/connect"
              >
                <input type="hidden" name="id" value={connections[0].id} />
                <button
                  className={controls.primary}
                  type="submit"
                  data-track="reconnect_gmail_click"
                  data-track-location="banner"
                >
                  Reconnect Gmail
                </button>
              </form>
            ) : null}
          </div>
          <div className={styles.reconnectAccounts}>
            <GmailAccounts
              accounts={connections}
              schedules={loadError ? null : schedules}
            />
          </div>
        </section>
      ) : null}

      {user && connections.length === 0 ? (
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
              Connect the Google account you want to send from. RecurMail sends
              each schedule from the account you choose for it, so recipients
              see your normal Gmail sender. You can add more accounts later.
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
              <button
                className={controls.primary}
                type="submit"
                data-track="connect_gmail_click"
                data-track-retry={params.gmail === "denied" ? "true" : "false"}
              >
                {params.gmail === "denied"
                  ? "Try connecting Gmail again"
                  : "Connect Gmail"}
              </button>
            </form>
          </div>
        </section>
      ) : null}

      {user && connected ? (
        <div className={styles.grid}>
          <ScheduleList
            initialSchedules={schedules}
            accounts={accounts}
            loadError={loadError}
          />
          <aside className={styles.sidebar}>
            <GmailAccounts
              accounts={connections}
              schedules={loadError ? null : schedules}
            />
          </aside>
        </div>
      ) : null}

      {user && !connected && (schedules.length || loadError) ? (
        <div className={styles.listBelow}>
          <ScheduleList
            initialSchedules={schedules}
            accounts={accounts}
            loadError={loadError}
          />
        </div>
      ) : null}
    </AppShell>
  );
}
