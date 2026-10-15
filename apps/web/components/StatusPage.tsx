import type { ReactNode } from "react";
import legal from "./LegalDocument.module.css";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import styles from "./StatusPage.module.css";

/** A branded full page for "not found" and error states. */
export function StatusPage({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className={legal.page}>
      <SiteHeader variant="legal" />
      <main id="main" className={`${legal.main} ${styles.main}`}>
        <span className={styles.eyebrow}>{eyebrow}</span>
        <h1>{title}</h1>
        <div className={styles.body}>{children}</div>
        <div className={styles.actions}>{actions}</div>
      </main>
      <SiteFooter variant="legal" />
    </div>
  );
}

export const statusStyles = styles;
