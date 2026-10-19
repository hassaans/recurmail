import type { ReactNode } from "react";
import styles from "./LegalDocument.module.css";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export function LegalDocument({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <SiteHeader variant="legal" />
      <main className={styles.main}>
        <h1>{title}</h1>
        <p className={styles.updated}>Last updated {updated}</p>
        <article>{children}</article>
      </main>
      <SiteFooter variant="legal" />
    </div>
  );
}
