import type { ReactNode } from "react";
import styles from "./LegalDocument.module.css";

export function LegalDocument({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a href="/">RecurMail</a>
        <a href="/dashboard">Open RecurMail</a>
      </header>
      <main className={styles.main}>
        <p className={styles.eyebrow}>RecurMail</p>
        <h1>{title}</h1>
        <p className={styles.updated}>Last updated October 14, 2026</p>
        <article>{children}</article>
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
