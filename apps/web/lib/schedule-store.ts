import "server-only";
import type { PublicConnection } from "./connections";
import type {
  ScheduleChanges,
  ScheduleRow,
  ScheduleStore,
  SendHistoryRow,
} from "./schedules";

const scheduleFields = [
  "id",
  "user_id",
  "subject",
  "body_text",
  "body_html",
  "to",
  "cc",
  "bcc",
  "rrule",
  "timezone",
  "source",
  "status",
  "next_send_at",
  "created_at",
  "updated_at",
] as const;
const connectionFields = [
  "user_id",
  "google_email",
  "is_workspace",
  "status",
  "connected_at",
] as const;
const updateFields = [
  "subject",
  "body_text",
  "body_html",
  "to",
  "cc",
  "bcc",
  "rrule",
  "timezone",
  "source",
  "status",
  "next_send_at",
  "updated_at",
] as const;
const historyFields = [
  "id",
  "scheduled_for",
  "attempted_at",
  "status",
  "error_code",
] as const;

export class ScheduleStorageError extends Error {
  constructor(readonly status: number) {
    super("Schedule storage failed");
  }
}

/** All operations use the caller's JWT, the anon API key and existing owner RLS. */
export function createScheduleStore(config: {
  url: string;
  publishableKey: string;
  fetcher?: typeof fetch;
}): ScheduleStore {
  const fetcher = config.fetcher ?? fetch;

  async function request(
    table: "schedules" | "gmail_connections" | "send_log",
    params: Record<string, string>,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    accessToken: string,
    body?: object,
  ): Promise<Record<string, unknown>[]> {
    const url = new URL(`${config.url}/rest/v1/${table}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url.toString(), {
      method,
      headers: {
        apikey: config.publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    if (!response.ok) throw new ScheduleStorageError(response.status);
    const rows: unknown = await response.json();
    if (
      !Array.isArray(rows) ||
      rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      throw new ScheduleStorageError(502);
    return rows;
  }

  function schedule(row: Record<string, unknown>, userId: string): ScheduleRow {
    if (row.user_id !== userId) throw new ScheduleStorageError(502);
    return Object.fromEntries(
      scheduleFields.map((field) => [field, row[field]]),
    ) as unknown as ScheduleRow;
  }

  function owner(userId: string): Record<string, string> {
    return { user_id: `eq.${userId}`, select: scheduleFields.join(",") };
  }

  // IDs are UUIDs in Supabase. Invalid or foreign IDs both produce no owned row,
  // avoiding database cast errors and disclosure of any other owner's records.
  const validId = (id: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  return {
    async list(userId, accessToken) {
      const rows = await request(
        "schedules",
        { ...owner(userId), order: "created_at.desc,id.asc" },
        "GET",
        accessToken,
      );
      return rows.map((row) => schedule(row, userId));
    },
    async get(userId, id, accessToken) {
      if (!validId(id)) return null;
      const rows = await request(
        "schedules",
        { ...owner(userId), id: `eq.${id}`, limit: "1" },
        "GET",
        accessToken,
      );
      return rows[0] ? schedule(rows[0], userId) : null;
    },
    async create(row, accessToken) {
      const body = Object.fromEntries(
        scheduleFields
          .filter((field) => field !== "id")
          .map((field) => [field, row[field]]),
      );
      const rows = await request(
        "schedules",
        { select: scheduleFields.join(",") },
        "POST",
        accessToken,
        body,
      );
      if (rows.length !== 1) throw new ScheduleStorageError(502);
      return schedule(rows[0], row.user_id);
    },
    async update(userId, id, changes: ScheduleChanges, accessToken) {
      if (!validId(id)) return null;
      const body = Object.fromEntries(
        updateFields
          .filter((field) => Object.hasOwn(changes, field))
          .map((field) => [field, changes[field]]),
      );
      const rows = await request(
        "schedules",
        { ...owner(userId), id: `eq.${id}` },
        "PATCH",
        accessToken,
        body,
      );
      return rows[0] ? schedule(rows[0], userId) : null;
    },
    async delete(userId, id, accessToken) {
      if (!validId(id)) return false;
      const rows = await request(
        "schedules",
        { ...owner(userId), id: `eq.${id}` },
        "DELETE",
        accessToken,
      );
      return rows.length > 0;
    },
    async pauseAll(userId, accessToken) {
      const rows = await request(
        "schedules",
        {
          user_id: `eq.${userId}`,
          status: "eq.active",
          select: "id",
        },
        "PATCH",
        accessToken,
        { status: "paused", updated_at: new Date().toISOString() },
      );
      return rows.length;
    },
    async readConnection(userId, accessToken) {
      const rows = await request(
        "gmail_connections",
        {
          user_id: `eq.${userId}`,
          select: connectionFields.join(","),
          limit: "1",
        },
        "GET",
        accessToken,
      );
      if (!rows[0]) return null;
      if (rows[0].user_id !== userId) throw new ScheduleStorageError(502);
      return Object.fromEntries(
        connectionFields.map((field) => [field, rows[0][field]]),
      ) as unknown as PublicConnection;
    },
    async history(userId, scheduleId, accessToken) {
      const rows = await request(
        "send_log",
        {
          user_id: `eq.${userId}`,
          schedule_id: `eq.${scheduleId}`,
          select: historyFields.join(","),
          order: "attempted_at.desc,id.asc",
        },
        "GET",
        accessToken,
      );
      return rows.map((row) => {
        if (
          row.status !== "sent" &&
          row.status !== "failed" &&
          row.status !== "deferred" &&
          row.status !== "skipped"
        )
          throw new ScheduleStorageError(502);
        return Object.fromEntries(
          historyFields.map((field) => [field, row[field]]),
        ) as unknown as SendHistoryRow;
      });
    },
  };
}
