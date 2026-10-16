/// <reference types="npm:@types/luxon@3.7.6" />

import { runSender } from "./engine.ts";
import { createSenderHandler } from "./handler.ts";
import { resolveSupabaseSecretKey } from "./secret-key.ts";
import {
  captureError,
  finishCronCheckIn,
  flushSentry,
  initSentry,
  startCronCheckIn,
} from "./sentry.ts";
import { createStore } from "./store.ts";

const required = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

initSentry(Deno.env.get("SENTRY_DSN"));
Deno.serve(
  createSenderHandler({
    getCronSecret: () => Deno.env.get("SENDER_CRON_SECRET"),
    execute: async ({ source }) => {
      const dsn = Deno.env.get("SENTRY_DSN");
      const checkIn = startCronCheckIn(
        dsn,
        Deno.env.get("SENTRY_CRON_MONITOR_SLUG"),
      );
      try {
        const result = await runSender(
          createStore(
            required("SUPABASE_URL"),
            resolveSupabaseSecretKey(
              Deno.env.get("SUPABASE_SECRET_KEYS"),
              Deno.env.get("SUPABASE_SECRET_KEY"),
            ),
          ),
          {
            key: required("TOKEN_ENCRYPTION_KEY"),
            clientId: required("GOOGLE_CLIENT_ID"),
            clientSecret: required("GOOGLE_CLIENT_SECRET"),
            appUrl: required("APP_URL"),
            resendApiKey: Deno.env.get("RESEND_API_KEY")?.trim() || "",
            reconnectEmailFrom:
              Deno.env.get("RECONNECT_EMAIL_FROM")?.trim() || "",
            recordIdleRun: source === "daily_keepalive",
          },
        );
        finishCronCheckIn(checkIn, "ok");
        return result;
      } catch (error) {
        captureError(error, dsn);
        finishCronCheckIn(checkIn, "error");
        throw error;
      } finally {
        await flushSentry(dsn);
      }
    },
  }),
);
