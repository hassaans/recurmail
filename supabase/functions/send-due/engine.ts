import { nextOccurrence } from "@recurmail/core";
import { decryptRefreshToken } from "./crypto.ts";
import { GmailError, type GmailSchedule, sendSchedule } from "./gmail.ts";

export type ClaimedSchedule = GmailSchedule & {
  schedule_id: string;
  user_id: string;
  scheduled_for: string;
  encrypted_refresh_token: string;
  rrule: string;
  timezone: string;
};

export type SenderStore = {
  claim(limit: number): Promise<ClaimedSchedule[]>;
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
    scheduledFor: string;
    recipient: string;
    reconnectUrl: string;
  }): Promise<void>;
  heartbeat(input: {
    id: string;
    startedAt: string;
    finishedAt: string;
    claimed: number;
    sent: number;
    failed: number;
    deferred: number;
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
};

export async function runSender(
  store: SenderStore,
  config: SenderConfig,
): Promise<Record<string, number | string>> {
  const now = config.now ?? (() => new Date());
  const startedAt = now();
  const schedules = await store.claim(50);
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  const send = config.send ?? sendSchedule;
  const reconnectUsers = new Set<string>();

  for (const schedule of schedules) {
    const scheduledFor = new Date(schedule.scheduled_for);
    if (reconnectUsers.has(schedule.user_id)) {
      await store.reconnect({
        scheduleId: schedule.schedule_id,
        userId: schedule.user_id,
        scheduledFor: schedule.scheduled_for,
        recipient: schedule.google_email,
        reconnectUrl: `${config.appUrl.replace(/\/$/, "")}/dashboard?gmail=failed`,
      });
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
      await store.complete({
        scheduleId: schedule.schedule_id,
        scheduledFor: schedule.scheduled_for,
        status: "sent",
        nextSendAt: next?.toISOString() ?? null,
        messageId,
      });
      sent += 1;
    } catch (error) {
      if (error instanceof GmailError && error.outcome === "invalid_grant") {
        reconnectUsers.add(schedule.user_id);
        await store.reconnect({
          scheduleId: schedule.schedule_id,
          userId: schedule.user_id,
          scheduledFor: schedule.scheduled_for,
          recipient: schedule.google_email,
          reconnectUrl: `${config.appUrl.replace(/\/$/, "")}/dashboard?gmail=failed`,
        });
        failed += 1;
        continue;
      }

      if (error instanceof GmailError && error.outcome === "defer") {
        await store.complete({
          scheduleId: schedule.schedule_id,
          scheduledFor: schedule.scheduled_for,
          status: "deferred",
          nextSendAt: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
          errorCode: error.code,
        });
        deferred += 1;
        continue;
      }

      const code =
        error instanceof GmailError ? error.code : "sender_internal_error";
      const next = nextOccurrence(
        schedule.rrule,
        schedule.timezone,
        scheduledFor,
      );
      await store.complete({
        scheduleId: schedule.schedule_id,
        scheduledFor: schedule.scheduled_for,
        status: "failed",
        nextSendAt: next?.toISOString() ?? null,
        errorCode: code,
      });
      failed += 1;
    }
  }

  const finishedAt = now();
  await store.heartbeat({
    id: crypto.randomUUID(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    claimed: schedules.length,
    sent,
    failed,
    deferred,
  });
  return { claimed: schedules.length, sent, failed, deferred };
}
