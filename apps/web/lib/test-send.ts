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
import { TEST_SEND_LIMIT, TEST_SEND_WINDOW_MS } from "./test-send-limit";

export { TEST_SEND_LIMIT, TEST_SEND_WINDOW_MS };
export const TEST_SUBJECT_PREFIX = "[Test] ";

/** The Gmail account a test is sent from. Only the handler ever sees the token. */
export interface TestSender {
  email: string;
  is_workspace: boolean;
  status: string;
  encrypted_refresh_token: string;
}

/**
 * The outcome of reserving a slot in the rolling window. A refusal names the
 * oldest send still inside the window, which is when the window frees up again
 * once the window length is added.
 */
export type TestSendClaim =
  | { allowed: true; id: string }
  | { allowed: false; oldestSentAt: string };

export interface TestSendStore {
  /** The caller's Gmail connection, or the one matching `connectionId` when it belongs to them. */
  findConnection(
    userId: string,
    connectionId?: string,
  ): Promise<TestSender | null>;
  /**
   * Reserve one send for this user, or learn when the window has room again.
   * Must be atomic per user: two concurrent claims never both succeed when
   * only one slot is left.
   */
  claim(userId: string): Promise<TestSendClaim>;
  /** Give a reservation back because the email did not go out. */
  release(userId: string, id: string): Promise<void>;
  /**
   * The refresh token is dead: mark the connection needs_reconnect and pause
   * the user's active schedules, in one transaction. No send_log row and no
   * reconnect email; the user is already reading the message.
   */
  markReconnectNeeded(userId: string): Promise<void>;
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
    path: string,
    params: Record<string, string>,
    method: "GET" | "POST" | "DELETE",
    operation: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`/rest/v1/${path}`, config.url);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        apikey: config.secretKey,
        "Content-Type": "application/json",
        ...(method === "DELETE" ? { Prefer: "return=minimal" } : {}),
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
    async claim(userId) {
      // One Postgres function call does the count and the insert under a
      // per-user lock, so the limit holds across concurrent requests.
      const response = await request(
        "rpc/claim_test_send",
        {},
        "POST",
        "claim_test_send",
        {
          p_user_id: userId,
          p_limit: TEST_SEND_LIMIT,
          p_window_seconds: TEST_SEND_WINDOW_MS / 1000,
        },
      );
      const result: unknown = await response.json();
      if (!result || typeof result !== "object")
        throw new TestSendStorageError("claim_test_send");
      const record = result as Record<string, unknown>;
      if (record.allowed === true && typeof record.id === "string")
        return { allowed: true, id: record.id };
      if (
        record.allowed === false &&
        typeof record.oldest_sent_at === "string" &&
        !Number.isNaN(Date.parse(record.oldest_sent_at))
      )
        return { allowed: false, oldestSentAt: record.oldest_sent_at };
      throw new TestSendStorageError("claim_test_send");
    },
    async release(userId, id) {
      await request(
        "test_sends",
        { id: `eq.${id}`, user_id: `eq.${userId}` },
        "DELETE",
        "release_test_send",
      );
    },
    async markReconnectNeeded(userId) {
      await request(
        "rpc/mark_test_send_reconnect_needed",
        {},
        "POST",
        "mark_test_send_reconnect_needed",
        { p_user_id: userId },
      );
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

/**
 * The window has room again one window length after its oldest send. The
 * message keeps to a relative wait so no time zone is baked in; the editor
 * shows `retry_at` in the reader's own zone.
 */
function rateLimited(oldestSentAt: string, at: number): Response {
  const retryAt = new Date(Date.parse(oldestSentAt) + TEST_SEND_WINDOW_MS);
  const waitSeconds = Math.max(0, Math.ceil((retryAt.getTime() - at) / 1000));
  const minutes = Math.ceil(waitSeconds / 60);
  const wait = minutes <= 1 ? "in a minute" : `in ${minutes} minutes`;
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message: `You've sent ${TEST_SEND_LIMIT} test emails in the last hour. Try again ${wait}.`,
        retry_at: retryAt.toISOString(),
      },
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(waitSeconds),
      },
    },
  );
}

/** A reservation that is not backed by a sent email must not count. */
async function releaseQuietly(
  store: TestSendStore,
  userId: string,
  id: string,
): Promise<void> {
  try {
    await store.release(userId, id);
  } catch {
    console.error("[ERROR] test_send_release_failed");
  }
}

/**
 * The dashboard must stop showing the account as healthy and the sender must
 * stop trying its schedules. If the write fails the user still gets the 409
 * telling them to reconnect; the sender's own invalid_grant path catches up.
 */
async function markReconnectNeededQuietly(
  store: TestSendStore,
  userId: string,
): Promise<void> {
  try {
    await store.markReconnectNeeded(userId);
  } catch {
    console.error("[ERROR] test_send_reconnect_mark_failed");
  }
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
      // Reserve first, then send. The reservation is the record of the send;
      // anything short of Gmail accepting the message gives it back.
      const claim = await config.store.claim(identity.user.id);
      if (!claim.allowed) return rateLimited(claim.oldestSentAt, at);
      let delivered = false;
      try {
        const refreshToken = decryptRefreshToken(
          sender.encrypted_refresh_token,
          config.key,
          identity.user.id,
        );
        let accessToken: string;
        try {
          accessToken = await config.google.refreshAccessToken(refreshToken);
        } catch (error) {
          if (
            error instanceof GoogleTokenError &&
            error.code === "invalid_grant"
          ) {
            await markReconnectNeededQuietly(config.store, identity.user.id);
            return failure(
              409,
              "gmail_reconnect_required",
              `Gmail access for ${sender.email} has expired. Reconnect it from the dashboard.`,
            );
          }
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
        delivered = true;
        return scheduleJson({ sent_to: identity.user.email });
      } finally {
        if (!delivered)
          await releaseQuietly(config.store, identity.user.id, claim.id);
      }
    } catch (error) {
      if (error instanceof RequestError)
        return failure(error.status, error.code, error.message);
      console.error("[ERROR] test_send_failed");
      return failure(500, "internal_error", "Could not send the test email");
    }
  };
}
