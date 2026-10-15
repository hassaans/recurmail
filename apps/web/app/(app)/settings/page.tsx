import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import AppShell from "../../../components/AppShell";
import controls from "../../../components/controls.module.css";
import { configuredRuntime } from "../../../lib/runtime";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Settings | RecurMail",
  robots: { index: false, follow: false },
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ delete?: string }>;
}) {
  const runtime = configuredRuntime();
  const state = runtime
    ? await runtime.dashboard(
        new Request("http://settings.internal", { headers: await headers() }),
      )
    : { kind: "signed_out" as const };
  if (state.kind !== "signed_in") redirect("/dashboard");
  const params = await searchParams;
  return (
    <AppShell email={state.user.email} active="settings">
      <header className={styles.pageHeader}>
        <p className={controls.eyebrow}>Account</p>
        <h1>Settings</h1>
      </header>
      <div className={styles.stack}>
        <section className={controls.card} aria-labelledby="account-title">
          <h2 id="account-title">Account</h2>
          <div className={styles.accountRow}>
            <p>
              Signed in with Google as{" "}
              <span className={styles.email}>{state.user.email}</span>
            </p>
            <form method="post" action="/auth/signout">
              <button className={controls.secondary} type="submit">
                Sign out
              </button>
            </form>
          </div>
        </section>
        <section
          className={`${controls.card} ${styles.danger}`}
          aria-labelledby="delete-title"
        >
          <h2 id="delete-title">Delete account</h2>
          <p>
            This permanently deletes your RecurMail account, schedules, email
            content, send history, reconnect data and stored Gmail tokens. It
            does not change anything in your Gmail account.
          </p>
          {params.delete === "failed" ? (
            <p className={controls.error} role="alert">
              Account deletion could not finish. Your account is still
              available. Please try again.
            </p>
          ) : null}
          <form className={styles.form} method="post" action="/api/account">
            <label htmlFor="confirmation">Type delete to confirm</label>
            <input
              id="confirmation"
              name="confirmation"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              pattern="delete"
              placeholder="delete"
              required
            />
            <button className={controls.danger} type="submit">
              Delete account
            </button>
          </form>
        </section>
      </div>
    </AppShell>
  );
}
