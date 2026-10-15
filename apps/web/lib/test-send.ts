import "server-only";
import { buildMime } from "@recurmail/core";
import { decryptRefreshToken } from "./crypto";
import type { Authenticate } from "./gmail-flow";
import {
  GmailSendError,
  type GoogleProvider,
  GoogleTokenError,
} from "./google";
import { sameOrigin } from "./http";
import {
  normalizeMessageContent,
  objectInput,
  RequestError,
  scheduleJson,
} from "./schedules";

/** How many test emails one user may send in a rolling hour. */
export const TEST_SEND_LIMIT = 5;
export const TEST_SEND_WINDOW_MS = 3600000;
export const TEST_SUBJECT_PREFIX = "[Test] ";

/** The Gmail account a test is sent from. Only the handler ever sees the token. */
export interface TestSender {
  email: string;
  is_workspace: boolean;
  status: string;
  encrypted_refresh_token: string;
}

export interface TestSendStore {
  /** The caller's Gmail connection, or the one matching `connectionId` when it belongs to them. */
  findConnection(
    userId: string,
    connectionId?: string,
  ): Promise<TestSender | null>;
  /** Test emails this user sent at or after `sinceIso`. */
  countSince(userId: string, sinceIso: string): Promise<number>;
  /** Record one sent test so it counts toward the limit. */
  record(userId: string, sentAtIso: string): Promise<void>;
}

export class TestSendStorageError extends Error {
  constructor(readonly operation: string) {
    super(`Test send storage failed: ${operation}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Service-role PostgREST access for the tables the test route touches. */
export function createTestSendStore(config: {
  url: string;
  secretKey: string;
  fetcher?: typeof fetch;
}): TestSendStore {
  const fetcher = config.fetcher ?? fetch;
  async function request(
    table: string,
    params: Record<string, string>,
    method: "GET" | "POST",
    operation: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`/rest/v1/${table}`, config.url);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        apikey: config.secretKey,
        "Content-Type": "application/json",
        ...(method === "POST" ? { Prefer: "return=minimal" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    if (!response.ok) throw new TestSendStorageError(operation);
    return response;
  }
  return {
    async findConnection(userId, connectionId) {
      const response = await request(
        "gmail_connections",
        {
          user_id: `eq.${userId}`,
          ...(connectionId ? { id: `eq.${connectionId}` } : {}),
          select: "id,google_email,is_workspace,status,encrypted_refresh_token",
          limit: "1",
        },
        "GET",
        "read_connection",
      );
      const rows: unknown = await response.json();
      if (!Array.isArray(rows))
        throw new TestSendStorageError("read_connection");
      const row = rows[0];
      if (!row || typeof row !== "object") return null;
      const record = row as Record<string, unknown>;
      if (
        typeof record.google_email !== "string" ||
        typeof record.status !== "string" ||
        typeof record.encrypted_refresh_token !== "string"
      )
        throw new TestSendStorageError("read_connection");
      return {
        email: record.google_email,
        is_workspace: record.is_workspace === true,
        status: record.status,
        encrypted_refresh_token: record.encrypted_refresh_token,
      };
    },
    async countSince(userId, sinceIso) {
      const response = await request(
        "test_sends",
        {
          user_id: `eq.${userId}`,
          sent_at: `gte.${sinceIso}`,
          select: "sent_at",
        },
        "GET",
        "count_test_sends",
      );
      const rows: unknown = await response.json();
      if (!Array.isArray(rows))
        throw new TestSendStorageError("count_test_sends");
      return rows.length;
    },
    async record(userId, sentAtIso) {
      await request("test_sends", {}, "POST", "record_test_send", {
        user_id: userId,
        sent_at: sentAtIso,
      });
    },
  };
}

/**
 * The single place that decides which Gmail account a test goes out from.
 * Today a user has one connection, so this returns it. When a connection id is
 * given it must belong to the caller; anything else resolves to no sender.
 */
export async function resolveTestSender(
  userId: string,
  connectionId: string | undefined,
  store: TestSendStore,
): Promise<TestSender | null> {
  if (connectionId !== undefined && !UUID.test(connectionId)) return null;
  return store.findConnection(userId, connectionId);
}

function failure(status: number, code: string, message: string): Response {
  return scheduleJson({ error: { code, message } }, status);
}

export function createTestSendHandler(config: {
  origin: string;
  key: string;
  authenticate: Authenticate;
  google: Pick<GoogleProvider, "refreshAccessToken" | "sendMessage">;
  store: TestSendStore;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  return async function sendTest(request: Request): Promise<Response> {
    if (!sameOrigin(request, config.origin))
      return failure(403, "forbidden_origin", "Cross-origin request rejected");
    const identity = await config.authenticate(request);
    if (!identity)
      return failure(401, "unauthenticated", "Sign in to send a test email");
    try {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new RequestError(400, "invalid_input", "Malformed JSON");
        throw error;
      }
      const input = objectInput(payload);
      // Recipients are deliberately ignored: a test only ever goes to the caller.
      const content = normalizeMessageContent(input);
      const connectionId = Object.hasOwn(input, "gmail_connection_id")
        ? input.gmail_connection_id
        : undefined;
      if (connectionId !== undefined && typeof connectionId !== "string")
        throw new RequestError(
          400,
          "invalid_input",
          "gmail_connection_id must be a string",
        );
      const sender = await resolveTestSender(
        identity.user.id,
        connectionId,
        config.store,
      );
      if (sender?.status !== "connected")
        return failure(409, "gmail_not_connected", "Connect Gmail first");
      const at = now();
      const since = new Date(at - TEST_SEND_WINDOW_MS).toISOString();
      const sent = await config.store.countSince(identity.user.id, since);
      if (sent >= TEST_SEND_LIMIT) {
        const retryAt = new Date(at + TEST_SEND_WINDOW_MS);
        const time = retryAt.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
          timeZoneName: "short",
        });
        return Response.json(
          {
            error: {
              code: "rate_limited",
              message: `You've sent ${TEST_SEND_LIMIT} test emails in the last hour. Try again at ${time}.`,
              retry_at: retryAt.toISOString(),
            },
          },
          {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": String(Math.ceil(TEST_SEND_WINDOW_MS / 1000)),
            },
          },
        );
      }
      const refreshToken = decryptRefreshToken(
        sender.encrypted_refresh_token,
        config.key,
        identity.user.id,
      );
      let accessToken: string;
      try {
        accessToken = await config.google.refreshAccessToken(refreshToken);
      } catch (error) {
        if (error instanceof GoogleTokenError && error.code === "invalid_grant")
          return failure(
            409,
            "gmail_reconnect_required",
            `Gmail access for ${sender.email} has expired. Reconnect it from the dashboard.`,
          );
        throw error;
      }
      const raw = buildMime({
        from: sender.email,
        to: [identity.user.email],
        subject: `${TEST_SUBJECT_PREFIX}${content.subject}`,
        text: content.body_text,
        ...(content.body_html === null ? {} : { html: content.body_html }),
        date: new Date(at),
      });
      try {
        await config.google.sendMessage(accessToken, raw);
      } catch (error) {
        if (error instanceof GmailSendError) {
          console.error("[ERROR] test_send_gmail_failed");
          return failure(
            502,
            "gmail_send_failed",
            "Gmail couldn't send the test email. Try again in a moment.",
          );
        }
        throw error;
      }
      await config.store.record(identity.user.id, new Date(at).toISOString());
      return scheduleJson({ sent_to: identity.user.email });
    } catch (error) {
      if (error instanceof RequestError)
        return failure(error.status, error.code, error.message);
      console.error("[ERROR] test_send_failed");
      return failure(500, "internal_error", "Could not send the test email");
    }
  };
}
