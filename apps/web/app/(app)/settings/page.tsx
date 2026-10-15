import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
    <div className={styles.page}>
      <header className={styles.header}>
        <a href="/">RecurMail</a>
        <nav aria-label="Account">
          <a href="/dashboard">Dashboard</a>
        </nav>
      </header>
      <main className={styles.main}>
        <p className={styles.eyebrow}>Account</p>
        <h1>Settings</h1>
        <p>Signed in as {state.user.email}</p>
        <section className={styles.card} aria-labelledby="delete-title">
          <h2 id="delete-title">Delete account</h2>
          <p>
            This permanently deletes your RecurMail account, schedules, email
            content, send history, reconnect data and stored Gmail token.
          </p>
          <p>Type delete below to confirm.</p>
          {params.delete === "failed" ? (
            <p className={styles.error} role="alert">
              Account deletion could not finish. Your account is still
              available. Please try again.
            </p>
          ) : null}
          <form method="post" action="/api/account">
            <label htmlFor="confirmation">Confirmation</label>
            <input
              id="confirmation"
              name="confirmation"
              autoComplete="off"
              pattern="delete"
              required
            />
            <button type="submit">Delete account</button>
          </form>
        </section>
      </main>
      <footer className={styles.footer}>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
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
