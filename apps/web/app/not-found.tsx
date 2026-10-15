import type { Metadata } from "next";
import { StatusPage, statusStyles } from "../components/StatusPage";

export const metadata: Metadata = {
  title: "Page not found | RecurMail",
};

export default function NotFound() {
  return (
    <StatusPage
      eyebrow="404"
      title="We couldn't find that page"
      actions={
        <>
          <a className={statusStyles.primary} href="/">
            Go to the homepage
          </a>
          <a className={statusStyles.secondary} href="/dashboard">
            Open your dashboard
          </a>
        </>
      }
    >
      The link may be old or mistyped. Your schedules are safe, and nothing was
      sent from this page.
    </StatusPage>
  );
}
