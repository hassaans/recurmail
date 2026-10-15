import styles from "../app/dashboard/page.module.css";
import {
  MAX_GMAIL_CONNECTIONS,
  type PublicConnection,
} from "../lib/connections";
import { countSchedules } from "../lib/schedule-state";
import type { ScheduleSummary } from "../lib/schedule-summary";
import ConfirmForm from "./ConfirmForm";
import controls from "./controls.module.css";

type GmailAccountsProps = {
  accounts: PublicConnection[];
  /** The user's schedules, or null when they could not be loaded. */
  schedules: ScheduleSummary[] | null;
};

function describeDisconnect(
  account: PublicConnection,
  schedules: ScheduleSummary[] | null,
): string {
  const lead = `RecurMail will give up its permission to send from ${account.google_email} and remove it from your account.`;
  if (schedules === null)
    return `${lead} Any schedules sending from it will pause until you choose another account for them. You can connect it again at any time.`;
  const using = schedules.filter(
    (schedule) => schedule.gmail_connection_id === account.id,
  );
  const active = using.filter(
    (schedule) => schedule.status !== "paused",
  ).length;
  const effect =
    using.length === 0
      ? "No schedules use it."
      : active === 0
        ? `No active schedules use it. The ${countSchedules(using.length)} already paused will need another account before they can send again.`
        : `${countSchedules(active)} will pause until you choose another account for ${active === 1 ? "it" : "them"}.`;
  return `${lead} ${effect} You can connect it again at any time.`;
}

// Every Gmail account the user has connected, with what each one can do.
// Server-rendered: the forms post to the connect and disconnect routes, and
// the confirmation is the shared ConfirmForm with plain-data props.
export default function GmailAccounts({
  accounts,
  schedules,
}: GmailAccountsProps) {
  return (
    <section
      className={`${controls.card} ${styles.accounts}`}
      aria-label="Gmail accounts"
    >
      <h2>Gmail accounts</h2>
      <ul className={styles.accountList}>
        {accounts.map((account) => {
          const connected = account.status === "connected";
          return (
            <li className={styles.account} key={account.id}>
              <div className={styles.accountHead}>
                <span className={styles.email}>{account.google_email}</span>
                <span
                  className={`${controls.pill} ${
                    connected ? controls.pillTeal : controls.pillWarn
                  }`}
                >
                  {connected ? "Connected" : "Needs reconnect"}
                </span>
              </div>
              <div className={styles.accountActions}>
                {connected ? null : (
                  <form method="post" action="/api/gmail/connect">
                    <input type="hidden" name="id" value={account.id} />
                    <button
                      className={`${controls.primary} ${controls.small}`}
                      type="submit"
                    >
                      Reconnect
                    </button>
                  </form>
                )}
                <ConfirmForm
                  trigger="Disconnect"
                  triggerStyle="dangerQuiet"
                  tone="danger"
                  title={`Disconnect ${account.google_email}?`}
                  description={describeDisconnect(account, schedules)}
                  confirmLabel="Disconnect"
                  pendingLabel="Disconnecting…"
                  action={`/api/gmail/disconnect?id=${encodeURIComponent(account.id)}`}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p>
        Each schedule sends from the account you choose for it. RecurMail cannot
        read your inbox, drafts or contacts.
      </p>
      <div className={styles.accountsFooter}>
        {accounts.length < MAX_GMAIL_CONNECTIONS ? (
          <form method="post" action="/api/gmail/connect">
            <button
              className={`${controls.secondary} ${controls.small}`}
              type="submit"
            >
              Add another Gmail account
            </button>
          </form>
        ) : (
          <p className={styles.limit}>
            You have connected the maximum of {MAX_GMAIL_CONNECTIONS} Gmail
            accounts. Disconnect one to add another.
          </p>
        )}
      </div>
    </section>
  );
}
