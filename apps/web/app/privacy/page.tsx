import type { Metadata } from "next";
import { LegalDocument } from "../../components/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy | RecurMail",
  description:
    "How RecurMail stores and uses account, Gmail and schedule data.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument title="Privacy Policy" updated="October 19, 2026">
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
      <h2 id="sharing">How Google user data is shared</h2>
      <p>
        Google user data means your Google account email address and identifier,
        the Gmail access token, and the messages RecurMail sends through Gmail
        for you. RecurMail does not sell Google user data. It does not use it
        for advertising, and does not use it to train artificial intelligence or
        machine learning models.
      </p>
      <p>RecurMail shares or transfers Google user data only in these cases:</p>
      <ul>
        <li>
          With Google, to send each scheduled message through the Gmail API and
          to revoke access when you disconnect Gmail or delete your account.
        </li>
        <li>
          With Supabase, which stores the data, and Vercel, which hosts the web
          app. They process it only to provide their service to RecurMail.
        </li>
        <li>
          With Resend, only the Gmail address that lost access and a link to
          reconnect it, so we can tell you when Gmail access stops working.
        </li>
        <li>When the law requires it, such as a valid court order.</li>
        <li>
          As part of a merger, acquisition or sale of RecurMail, only after
          asking for your explicit consent first.
        </li>
      </ul>
      <p>
        Error reports sent to Sentry have email addresses, recipients, subjects
        and message content removed before they leave RecurMail. No person reads
        your messages unless you ask us to for support, it is needed to
        investigate abuse or a security issue, or the law requires it.
      </p>
      <h2 id="protection">How we protect your data</h2>
      <ul>
        <li>
          All connections between your browser, RecurMail, Supabase and Google
          use HTTPS (TLS) encryption.
        </li>
        <li>
          The Gmail refresh token is encrypted with AES-256-GCM using a key kept
          outside the database. It is decrypted only on our servers to send your
          messages, and is never sent to your browser.
        </li>
        <li>
          Supabase encrypts stored data at rest. Database row-level security
          limits each account to its own Gmail connection, schedules and send
          history.
        </li>
        <li>Your sign-in session is kept in an encrypted, HTTP-only cookie.</li>
        <li>
          RecurMail requests only the <code>gmail.send</code> Gmail scope, so it
          cannot read your mailbox.
        </li>
        <li>
          Access to production systems is limited to the person who runs
          RecurMail.
        </li>
      </ul>
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
