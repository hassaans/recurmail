import type { Metadata } from "next";
import { LegalDocument } from "../../components/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy | RecurMail",
  description:
    "How RecurMail stores and uses account, Gmail and schedule data.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument title="Privacy Policy">
      <p>
        RecurMail helps you send recurring messages from your own Gmail account.
        This policy explains what information the service uses and how you can
        remove it.
      </p>
      <h2>Google account and Gmail access</h2>
      <p>
        RecurMail uses Google sign-in for your account. To send scheduled email,
        you separately grant the Google scope{" "}
        <code>https://www.googleapis.com/auth/gmail.send</code>. This scope lets
        RecurMail send messages through Gmail. It does not allow RecurMail to
        read your inbox, drafts or contacts.
      </p>
      <p>
        RecurMail handles Google user data under the Google API Services User
        Data Policy, including its Limited Use requirements. We use Gmail access
        only to send the messages you schedule and to revoke that access when
        you disconnect or delete your account.
      </p>
      <h2>Information we store</h2>
      <ul>
        <li>Your account email address and account identifier.</li>
        <li>Your Gmail address and connection status.</li>
        <li>The refresh token needed to send scheduled messages.</li>
        <li>Schedule rules, recipients, subject and message content.</li>
        <li>Send time, status and error code for delivery history.</li>
      </ul>
      <p>
        The refresh token is encrypted before it is stored. It is not sent to
        your browser. Send history does not include message subject, body or
        recipient addresses. Schedule content remains stored while the schedule
        exists.
      </p>
      <h2>How we use information</h2>
      <p>
        We use account and schedule data to run the service, send the messages
        you scheduled, show delivery history, and help you reconnect Gmail if
        Google access stops working. Reconnect emails use Resend. RecurMail
        sends Resend the recipient address and reconnect link needed to deliver
        that notice. Your scheduled message content is not sent to Resend.
      </p>
      <p>
        Sentry is RecurMail's error-tracking service. It processes error reports
        so we can diagnose service failures. We do not use third-party product
        analytics.
      </p>
      <h2>Service providers and retention</h2>
      <p>
        Supabase stores account and application data. Vercel hosts the web app.
        Sentry processes error reports, and Resend delivers Gmail reconnect
        notices. These providers process information to provide their service.
        We retain account data while your account is active. Send history and
        schedules are removed when you delete your account. Error reports may be
        kept by Sentry under the retention settings on our account.
      </p>
      <h2>Disconnecting and deleting your account</h2>
      <p>
        You can disconnect Gmail from your account settings. This asks Google to
        revoke the stored token and pauses your schedules. You can delete your
        account from Settings. RecurMail attempts to revoke the Google token and
        then deletes your account and its related schedules, Gmail connection,
        send history and reconnect data. If Google revocation is unavailable,
        RecurMail still deletes the account and stored token.
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
