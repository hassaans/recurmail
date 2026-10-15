import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import BrandMark from "./BrandMark";
import controls from "./controls.module.css";

type AppShellProps = {
  children: ReactNode;
  /** Signed-in email. When absent the shell renders the signed-out header. */
  email?: string;
  active?: "schedules" | "settings";
};

// One shell for every signed-in page: brand logo, Schedules/Settings
// navigation, the signed-in account with Sign out, and the shared legal footer.
export default function AppShell({ children, email, active }: AppShellProps) {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div
          className={`${styles.inner} ${styles.headerInner} ${
            email ? styles.signedIn : ""
          }`}
        >
          <a
            className={styles.logo}
            href="/dashboard"
            aria-label="RecurMail home"
          >
            <BrandMark />
            RecurMail
          </a>
          {email ? (
            <>
              <nav className={styles.nav} aria-label="Main navigation">
                <a
                  className={styles.navLink}
                  aria-current={active === "schedules" ? "page" : undefined}
                  href="/dashboard"
                >
                  Schedules
                </a>
                <a
                  className={styles.navLink}
                  aria-current={active === "settings" ? "page" : undefined}
                  href="/settings"
                >
                  Settings
                </a>
              </nav>
              <div className={styles.account}>
                <span className={styles.email} title={email}>
                  <span className={controls.srOnly}>Signed in as </span>
                  {email}
                </span>
                <form method="post" action="/auth/signout">
                  <button
                    className={`${controls.quiet} ${controls.small}`}
                    type="submit"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </>
          ) : null}
        </div>
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
      <footer className={styles.footer}>
        <div className={`${styles.inner} ${styles.footerInner}`}>
          <nav aria-label="Legal">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="mailto:support@recurmail.com">Support</a>
          </nav>
          <p>
            Gmail is a trademark of Google LLC. RecurMail is not affiliated with
            Google.
          </p>
        </div>
      </footer>
    </div>
  );
}
