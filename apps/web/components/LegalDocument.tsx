import type { ReactNode } from "react";
import styles from "./LegalDocument.module.css";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export function LegalDocument({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <SiteHeader variant="legal" />
      <main className={styles.main}>
        <h1>{title}</h1>
        <p className={styles.updated}>Last updated October 16, 2026</p>
        <article>{children}</article>
      </main>
      <SiteFooter variant="legal" />
    </div>
  );
}
