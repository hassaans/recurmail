import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import ScheduleList from "../../components/ScheduleList";
import { configuredRuntime } from "../../lib/runtime";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Your Gmail connection | RecurMail",
  robots: { index: false, follow: false },
};

const messages: Record<string, string> = {
  denied:
    "Gmail permission was declined. RecurMail needs permission to send your scheduled emails. It cannot read your inbox. You can try again when you are ready.",
  failed:
    "Gmail could not be connected. Please try again and use the same Google account you used to sign in.",
  connected: "Gmail is connected. RecurMail can send your scheduled emails.",
  disconnected: "Gmail is disconnected. All your schedules are paused.",
  disconnect_failed:
    "Disconnect could not finish. Please try again. Your Gmail connection will stay here until Google revocation and removal are complete.",
};

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; auth?: string; warning?: string }>;
}) {
  const params = await searchParams;
  const runtime = configuredRuntime();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://dashboard.internal", { headers: await headers() }),
      )
    : { kind: "signed_out" as const };
  if (state.kind === "refresh") redirect("/auth/refresh");
  const user = state.kind === "signed_in" ? state.user : null;
  const connection = state.kind === "signed_in" ? state.connection : null;
  const connected = connection?.status === "connected";
  const message = params.gmail ? messages[params.gmail] : null;
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <a className={styles.logo} href="/">
          RecurMail
        </a>
        {user ? <a href="/settings">Settings</a> : null}
      </header>
      <main id="main" className={styles.main}>
        <p className={styles.eyebrow}>Send from your own Gmail</p>
        <h1>Your Gmail connection</h1>
        {message ? (
          <p className={styles.notice} role="status">
            {message}
          </p>
        ) : null}
        {params.auth === "failed" ? (
          <p className={styles.notice} role="status">
            Google sign-in could not finish. Please try again.
          </p>
        ) : null}
        {state.kind === "unavailable" || params.auth === "unavailable" ? (
          <p className={styles.notice} role="alert">
            Your connection is unavailable right now. Please try again later.
          </p>
        ) : null}
        {user && connected ? <ScheduleList warning={params.warning} /> : null}
        <section className={styles.card} aria-label="Gmail account">
          {!user ? (
            <>
              <h2>Sign in to get started</h2>
              <p>
                Sign in with Google, then connect that same account to send
                scheduled emails.
              </p>
              <a className={styles.button} href="/auth/signin">
                Sign in with Google
              </a>
            </>
          ) : (
            <>
              <p className={styles.email}>Signed in as {user.email}</p>
              <h2>{connected ? "Gmail is connected" : "Connect Gmail"}</h2>
              {connected ? (
                <>
                  <p>
                    {connection.google_email} is connected as a{" "}
                    {connection.is_workspace
                      ? "Google Workspace"
                      : "personal Gmail"}{" "}
                    account.
                  </p>
                  <p>
                    Disconnecting revokes sending permission and pauses all your
                    schedules.
                  </p>
                </>
              ) : (
                <>
                  {connection?.status === "needs_reconnect" ? (
                    <div className={styles.reconnect} role="alert">
                      <p>
                        Your Gmail permission needs renewing. Reconnect Gmail to
                        send scheduled emails again.
                      </p>
                      <form method="post" action="/api/gmail/connect">
                        <button className={styles.button} type="submit">
                          Reconnect Gmail
                        </button>
                      </form>
                    </div>
                  ) : null}
                  <p>
                    Connect the same Google account you used to sign in,{" "}
                    {user.email}. Choose this account on the Google consent
                    screen.
                  </p>
                  <p>
                    RecurMail asks only for permission to send email. It cannot
                    read your inbox, drafts or contacts.
                  </p>
                </>
              )}
              <form
                method="post"
                action={
                  connected ? "/api/gmail/disconnect" : "/api/gmail/connect"
                }
              >
                <button className={styles.button} type="submit">
                  {connected
                    ? "Disconnect"
                    : params.gmail === "denied" || params.gmail === "failed"
                      ? "Try connecting Gmail again"
                      : "Connect Gmail"}
                </button>
              </form>
              {!connected && connection ? (
                <form method="post" action="/api/gmail/disconnect">
                  <button className={styles.secondary} type="submit">
                    Disconnect
                  </button>
                </form>
              ) : null}
            </>
          )}
        </section>
      </main>
      <footer className={styles.footer}>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          {" · "}
          <a href="/terms">Terms</a>
        </nav>
        <p>
          Gmail is a trademark of Google LLC. RecurMail is not affiliated with
          Google.
        </p>
      </footer>
    </div>
  );
}
