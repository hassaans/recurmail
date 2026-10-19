import type { Metadata } from "next";
import { LegalDocument } from "../../components/LegalDocument";

export const metadata: Metadata = {
  title: "Terms of Service | RecurMail",
  description: "Terms for using RecurMail.",
};

export default function TermsPage() {
  return (
    <LegalDocument title="Terms of Service" updated="October 15, 2026">
      <p>
        These terms cover your use of RecurMail. By using the service, you agree
        to them. If you do not agree, do not connect an account or create a
        schedule.
      </p>
      <h2>Your account and schedules</h2>
      <p>
        You are responsible for the schedules and recipients you add. Keep your
        account access secure and check that each schedule is correct. RecurMail
        sends messages from your Gmail account under the permission you grant to
        Google.
      </p>
      <h2>Gmail and sending limits</h2>
      <p>
        Gmail and Google Workspace set their own sending limits and may change
        or withdraw access. RecurMail cannot promise that Google will accept or
        deliver every message. Check your schedules and delivery history, and
        pause or delete schedules you no longer want to run.
      </p>
      <h2>Availability and changes</h2>
      <p>
        RecurMail may be unavailable during maintenance or because a provider is
        unavailable. We may change or stop features. We will update these terms
        when the service or its terms change.
      </p>
      <h2>Deleting your account</h2>
      <p>
        You can delete your account from Settings. Deletion removes your
        schedules, stored Gmail token and related send history from RecurMail.
      </p>
      <h2>Contact</h2>
      <p>
        RecurMail is run by Hassaan Saleem. For help with your account, email{" "}
        <a href="mailto:support@recurmail.com">support@recurmail.com</a>. For
        privacy questions, email{" "}
        <a href="mailto:privacy@recurmail.com">privacy@recurmail.com</a>. For
        legal questions, email{" "}
        <a href="mailto:legal@recurmail.com">legal@recurmail.com</a>.
      </p>
    </LegalDocument>
  );
}
