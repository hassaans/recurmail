import { nextOccurrence } from "@recurmail/core";
import { decryptRefreshToken } from "./crypto.ts";
import { GmailError, type GmailSchedule, sendSchedule } from "./gmail.ts";

export type ClaimedSchedule = GmailSchedule & {
  schedule_id: string;
  user_id: string;
  /** The Gmail account this schedule sends from. */
  gmail_connection_id: string;
  scheduled_for: string;
  encrypted_refresh_token: string;
  rrule: string;
  timezone: string;
};

export type ReconnectNotice = {
  id: string;
  recipient: string;
  reconnect_url: string;
  attempts: number;
};

export type SenderStore = {
  claim(limit: number): Promise<ClaimedSchedule[]>;
  claimReconnectNotices(limit: number): Promise<ReconnectNotice[]>;
  markReconnectNoticeSent(id: string): Promise<void>;
  markReconnectNoticeFailed(id: string, errorCode: string): Promise<void>;
  reclaimStaleSending(olderThan: string): Promise<ClaimedSchedule[]>;
  recordFailure(input: {
    scheduleId: string;
    scheduledFor: string;
    errorCode: string;
  }): Promise<void>;
  complete(input: {
    scheduleId: string;
    scheduledFor: string;
    status: "sent" | "failed" | "deferred";
    nextSendAt: string | null;
    messageId?: string;
    errorCode?: string;
  }): Promise<void>;
  reconnect(input: {
    scheduleId: string;
    userId: string;
    connectionId: string;
    scheduledFor: string;
    recipient: string;
    reconnectUrl: string;
  }): Promise<void>;
  failureMetrics?(): Promise<{
    failed: number;
    attempted: number;
    rate: number;
  }>;
  heartbeat(input: {
    id: string;
    startedAt: string;
    finishedAt: string;
    claimed: number;
    sent: number;
    failed: number;
    deferred: number;
    noticesSent: number;
    noticesFailed: number;
    failureRateLastHour: number | null;
    failedLastHour: number | null;
    attemptedLastHour: number | null;
  }): Promise<void>;
};

export type SenderConfig = {
  key: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  now?: () => Date;
  send?: typeof sendSchedule;
  fetcher?: typeof fetch;
  resendApiKey?: string;
  reconnectEmailFrom?: string;
  resendEndpoint?: string;
};

export async function runSender(
  store: SenderStore,
  config: SenderConfig,
): Promise<Record<string, number | string>> {
  const now = config.now ?? (() => new Date());
  const startedAt = now();
  let schedules: ClaimedSchedule[] = [];
  let recovered: ClaimedSchedule[] = [];
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let noticesSent = 0;
  let noticesFailed = 0;
  const send = config.send ?? sendSchedule;
  // Accounts whose refresh token Google rejected during this run. Later
  // claims for the same account are failed without another send attempt,
  // while the user's other accounts keep sending.
  const reconnectConnections = new Set<string>();

  const errorCodeFor = (error: unknown): string =>
    error instanceof GmailError ? error.code : "sender_internal_error";
  const logStoreFailure = async (
    schedule: ClaimedSchedule,
    errorCode: string,
  ): Promise<void> => {
    console.error("sender schedule store operation failed", {
      scheduleId: schedule.schedule_id,
      errorCode,
    });
    try {
      await store.recordFailure({
        scheduleId: schedule.schedule_id,
        scheduledFor: schedule.scheduled_for,
        errorCode,
      });
    } catch {
      console.error("sender failure record could not be persisted", {
        scheduleId: schedule.schedule_id,
        errorCode: "failure_log_store_failed",
      });
    }
  };

  try {
    try {
      recovered = await store.reclaimStaleSending("10 minutes");
    } catch {
      console.error("sender stale-claim recovery failed", {
        errorCode: "stale_recovery_store_failed",
      });
    }

    for (const schedule of recovered) {
      try {
        const next = nextOccurrence(
          schedule.rrule,
          schedule.timezone,
          new Date(schedule.scheduled_for),
        );
        await store.complete({
          scheduleId: schedule.schedule_id,
          scheduledFor: schedule.scheduled_for,
          status: "failed",
          nextSendAt: next?.toISOString() ?? null,
          errorCode: "claim_expired",
        });
        failed += 1;
      } catch {
        failed += 1;
        await logStoreFailure(schedule, "claim_expired_store_failed");
      }
    }

    schedules = await store.claim(50);
    for (const schedule of schedules) {
      const scheduledFor = new Date(schedule.scheduled_for);
      if (reconnectConnections.has(schedule.gmail_connection_id)) {
        try {
          await store.reconnect({
            scheduleId: schedule.schedule_id,
            userId: schedule.user_id,
            connectionId: schedule.gmail_connection_id,
            scheduledFor: schedule.scheduled_for,
            recipient: schedule.google_email,
            reconnectUrl: `${config.appUrl.replace(/\/$/, "")}/dashboard?gmail=failed`,
          });
        } catch {
          await logStoreFailure(schedule, "reconnect_store_failed");
        }
        failed += 1;
        continue;
      }

      try {
        const refreshToken = await decryptRefreshToken(
          schedule.encrypted_refresh_token,
          config.key,
          schedule.user_id,
        );
        const messageId = await send(schedule, refreshToken, {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          ...(config.fetcher ? { fetcher: config.fetcher } : {}),
        });
        const next = nextOccurrence(
          schedule.rrule,
          schedule.timezone,
          scheduledFor,
        );
        try {
          await store.complete({
            scheduleId: schedule.schedule_id,
            scheduledFor: schedule.scheduled_for,
            status: "sent",
            nextSendAt: next?.toISOString() ?? null,
            messageId,
          });
          sent += 1;
        } catch {
          failed += 1;
          await logStoreFailure(schedule, "post_send_store_failed");
        }
      } catch (error) {
        if (error instanceof GmailError && error.outcome === "invalid_grant") {
          reconnectConnections.add(schedule.gmail_connection_id);
          try {
            await store.reconnect({
              scheduleId: schedule.schedule_id,
              userId: schedule.user_id,
              connectionId: schedule.gmail_connection_id,
              scheduledFor: schedule.scheduled_for,
              recipient: schedule.google_email,
              reconnectUrl: `${config.appUrl.replace(/\/$/, "")}/dashboard?gmail=failed`,
            });
          } catch {
            await logStoreFailure(schedule, "reconnect_store_failed");
          }
          failed += 1;
          continue;
        }

        if (error instanceof GmailError && error.outcome === "defer") {
          try {
            await store.complete({
              scheduleId: schedule.schedule_id,
              scheduledFor: schedule.scheduled_for,
              status: "deferred",
              nextSendAt: new Date(
                now().getTime() + 60 * 60 * 1000,
              ).toISOString(),
              errorCode: error.code,
            });
            deferred += 1;
          } catch {
            failed += 1;
            await logStoreFailure(schedule, "deferred_store_failed");
          }
          continue;
        }

        const code = errorCodeFor(error);
        const next = nextOccurrence(
          schedule.rrule,
          schedule.timezone,
          scheduledFor,
        );
        try {
          await store.complete({
            scheduleId: schedule.schedule_id,
            scheduledFor: schedule.scheduled_for,
            status: "failed",
            nextSendAt: next?.toISOString() ?? null,
            errorCode: code,
          });
        } catch {
          await logStoreFailure(schedule, "failed_store_failed");
        }
        failed += 1;
      }
    }
    const apiKey = config.resendApiKey?.trim() || "";
    const from = config.reconnectEmailFrom?.trim() || "";
    if (!apiKey) {
      console.error("reconnect notice dispatch skipped", {
        errorCode: "resend_api_key_missing",
      });
    } else if (!from) {
      console.error("reconnect notice dispatch skipped", {
        errorCode: "reconnect_email_from_missing",
      });
    } else {
      let notices: ReconnectNotice[] = [];
      try {
        notices = await store.claimReconnectNotices(20);
      } catch {
        console.error("reconnect notice claim failed", {
          errorCode: "notice_claim_store_failed",
        });
        noticesFailed += 1;
      }
      for (const notice of notices) {
        let errorCode: string | undefined;
        try {
          const link = notice.reconnect_url;
          const response = await (config.fetcher ?? fetch)(
            config.resendEndpoint || "https://api.resend.com/emails",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                from,
                to: [notice.recipient],
                subject:
                  "Reconnect Gmail to keep your RecurMail schedules running",
                text: `Your schedules are paused because Google access stopped working. Reconnect Gmail here: ${link}`,
                html: `<p>Your schedules are paused because Google access stopped working.</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
              }),
            },
          );
          if (!response.ok) errorCode = `resend_http_${response.status}`;
        } catch {
          errorCode = "resend_network_error";
        }
        if (!errorCode) {
          try {
            await store.markReconnectNoticeSent(notice.id);
            noticesSent += 1;
          } catch {
            errorCode = "notice_sent_store_failed";
            console.error("reconnect notice store operation failed", {
              noticeId: notice.id,
              errorCode,
            });
            noticesFailed += 1;
          }
        }
        if (errorCode && errorCode !== "notice_sent_store_failed") {
          try {
            await store.markReconnectNoticeFailed(notice.id, errorCode);
          } catch {
            console.error("reconnect notice store operation failed", {
              noticeId: notice.id,
              errorCode: "notice_failure_store_failed",
            });
          }
          noticesFailed += 1;
        }
      }
    }
    return {
      claimed: schedules.length + recovered.length,
      sent,
      failed,
      deferred,
      notices_sent: noticesSent,
      notices_failed: noticesFailed,
    };
  } finally {
    const finishedAt = now();
    let failureMetrics: {
      failed: number;
      attempted: number;
      rate: number;
    } | null = null;
    try {
      if (store.failureMetrics) failureMetrics = await store.failureMetrics();
    } catch (error) {
      console.error("sender failure-rate query failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await store.heartbeat({
      id: crypto.randomUUID(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      claimed: schedules.length + recovered.length,
      sent,
      failed,
      deferred,
      noticesSent,
      noticesFailed,
      failureRateLastHour: failureMetrics?.rate ?? null,
      failedLastHour: failureMetrics?.failed ?? null,
      attemptedLastHour: failureMetrics?.attempted ?? null,
    });
  }
}

function escapeHtml(value: string): string {
  const escaped: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(
    /[&<>"']/g,
    (character) => escaped[character] || character,
  );
}
