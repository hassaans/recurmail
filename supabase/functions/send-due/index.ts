/// <reference types="npm:@types/luxon@3.7.6" />

import { runSender, type SenderStore } from "./engine.ts";
import { createSenderHandler } from "./handler.ts";

const required = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

function createStore(url: string, serviceKey: string): SenderStore {
  const base = `${url.replace(/\/$/, "")}/rest/v1`;
  async function rpc<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${base}/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!response.ok)
      throw new Error(`Supabase RPC ${name} failed (${response.status})`);
    return (await response.json()) as T;
  }
  return {
    claim: (limit) => rpc("claim_due_schedules", { p_limit: limit }),
    claimReconnectNotices: (limit) =>
      rpc("claim_reconnect_email_outbox", { p_limit: limit }),
    markReconnectNoticeSent: async (id) => {
      await rpc("mark_reconnect_email_sent", { p_notice_id: id });
    },
    markReconnectNoticeFailed: async (id, errorCode) => {
      await rpc("mark_reconnect_email_failed", {
        p_notice_id: id,
        p_error_code: errorCode,
      });
    },
    reclaimStaleSending: (olderThan) =>
      rpc("reclaim_stale_sending", { p_older_than: olderThan }),
    recordFailure: async (input) => {
      await rpc("record_sender_failure", {
        p_schedule_id: input.scheduleId,
        p_scheduled_for: input.scheduledFor,
        p_error_code: input.errorCode,
      });
    },
    complete: async (input) => {
      await rpc("complete_due_schedule", {
        p_schedule_id: input.scheduleId,
        p_scheduled_for: input.scheduledFor,
        p_status: input.status,
        p_next_send_at: input.nextSendAt,
        p_message_id: input.messageId ?? null,
        p_error_code: input.errorCode ?? null,
      });
    },
    reconnect: async (input) => {
      await rpc("mark_gmail_reconnect_needed", {
        p_schedule_id: input.scheduleId,
        p_user_id: input.userId,
        p_scheduled_for: input.scheduledFor,
        p_recipient: input.recipient,
        p_reconnect_url: input.reconnectUrl,
      });
    },
    heartbeat: async (input) => {
      const response = await fetch(`${base}/sender_heartbeats`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        body: JSON.stringify({
          id: input.id,
          started_at: input.startedAt,
          finished_at: input.finishedAt,
          claimed_count: input.claimed,
          sent_count: input.sent,
          failed_count: input.failed,
          deferred_count: input.deferred,
          notices_sent: input.noticesSent,
          notices_failed: input.noticesFailed,
        }),
      });
      if (!response.ok)
        throw new Error(
          `Supabase heartbeat insert failed (${response.status})`,
        );
    },
  };
}

Deno.serve(
  createSenderHandler({
    getCronSecret: () => Deno.env.get("SENDER_CRON_SECRET"),
    execute: () =>
      runSender(
        createStore(
          required("SUPABASE_URL"),
          required("SUPABASE_SERVICE_ROLE_KEY"),
        ),
        {
          key: required("TOKEN_ENCRYPTION_KEY"),
          clientId: required("GOOGLE_CLIENT_ID"),
          clientSecret: required("GOOGLE_CLIENT_SECRET"),
          appUrl: required("APP_URL"),
          resendApiKey: Deno.env.get("RESEND_API_KEY")?.trim() || "",
          reconnectEmailFrom:
            Deno.env.get("RECONNECT_EMAIL_FROM")?.trim() || "",
        },
      ),
  }),
);
