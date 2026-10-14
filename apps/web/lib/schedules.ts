import "server-only";
import {
  type AccountType,
  dailyLimitCheck,
  nextOccurrence,
} from "@recurmail/core";
import type { PublicConnection } from "./connections";
import type { Authenticate, Identity } from "./gmail-flow";
import { sameOrigin } from "./http";
import { sanitizeScheduleHtml } from "./sanitize";
import { ScheduleStorageError } from "./schedule-store";

export interface ScheduleInput {
  subject: string;
  body_text: string;
  body_html: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  rrule: string;
  timezone: string;
  source: "web" | "api" | "cli" | "mcp";
}

export interface ScheduleRow extends ScheduleInput {
  id: string;
  user_id: string;
  status: "active" | "paused" | "sending";
  next_send_at: string;
  created_at: string;
  updated_at: string;
}

export type ScheduleChanges = Partial<ScheduleInput> &
  Partial<Pick<ScheduleRow, "status" | "next_send_at" | "updated_at">>;

export interface ScheduleStore {
  list(userId: string, accessToken: string): Promise<ScheduleRow[]>;
  get(
    userId: string,
    id: string,
    accessToken: string,
  ): Promise<ScheduleRow | null>;
  create(
    row: Omit<ScheduleRow, "id">,
    accessToken: string,
  ): Promise<ScheduleRow>;
  update(
    userId: string,
    id: string,
    changes: ScheduleChanges,
    accessToken: string,
  ): Promise<ScheduleRow | null>;
  delete(userId: string, id: string, accessToken: string): Promise<boolean>;
  pauseAll(userId: string, accessToken: string): Promise<number>;
  readConnection(
    userId: string,
    accessToken: string,
  ): Promise<PublicConnection | null>;
}

const editableFields = [
  "subject",
  "body_text",
  "body_html",
  "to",
  "cc",
  "bcc",
  "rrule",
  "timezone",
  "source",
] as const;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new RequestError(400, "invalid_input", message);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected a JSON object");
  return value as Record<string, unknown>;
}

function stringInput(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    invalid(`${field} must be a string of ${min} to ${max} characters`);
  return value;
}

// Match the bare ASCII mailboxes accepted by the core MIME builder.
function recipients(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    invalid(`${field} must be an array of email addresses`);
  return value.map((email: unknown) => {
    if (typeof email !== "string" || /[\r\n]/.test(email))
      invalid(`${field} contains an invalid email address`);
    const parts = email.split("@");
    if (
      parts.length !== 2 ||
      email.length > 254 ||
      parts[0].length > 64 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) ||
      parts[0].startsWith(".") ||
      parts[0].endsWith(".") ||
      parts[0].includes("..") ||
      !parts[1]
        .split(".")
        .every((label) =>
          /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
        )
    )
      invalid(`${field} contains an invalid email address`);
    return email;
  });
}

function occurrence(rrule: string, timezone: string, at: Date): Date | null {
  try {
    return nextOccurrence(rrule, timezone, at);
  } catch (error) {
    if (error instanceof RangeError) invalid("Invalid RRULE or IANA timezone");
    throw error;
  }
}

function normalize(value: unknown, at: Date): ScheduleInput {
  const input = objectInput(value);
  const subject = stringInput(input.subject, "subject", 1, 998);
  if (
    [...subject].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid("subject must not contain control characters");
  const body_text = stringInput(input.body_text, "body_text", 0, 100000);
  const body_html =
    !Object.hasOwn(input, "body_html") || input.body_html === null
      ? null
      : stringInput(input.body_html, "body_html", 0, 100000);
  const safeBodyHtml =
    body_html === null ? null : sanitizeScheduleHtml(body_html);
  const to = recipients(input.to, "to");
  const cc = Object.hasOwn(input, "cc") ? recipients(input.cc, "cc") : [];
  const bcc = Object.hasOwn(input, "bcc") ? recipients(input.bcc, "bcc") : [];
  if (to.length + cc.length + bcc.length === 0)
    invalid("At least one recipient is required");
  const rrule = stringInput(input.rrule, "rrule", 1, Number.MAX_SAFE_INTEGER);
  const timezone = stringInput(
    input.timezone,
    "timezone",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  occurrence(rrule, timezone, at);
  const source = Object.hasOwn(input, "source") ? input.source : "web";
  if (
    source !== "web" &&
    source !== "api" &&
    source !== "cli" &&
    source !== "mcp"
  )
    invalid("source must be web, api, cli or mcp");
  // Only this projection can reach persistence; owner and lifecycle fields are server-owned.
  return {
    subject,
    body_text,
    body_html: safeBodyHtml,
    to,
    cc,
    bcc,
    rrule,
    timezone,
    source,
  };
}

export function validateScheduleInput(value: unknown): ScheduleInput {
  return normalize(value, new Date());
}

function nextSend(
  input: Pick<ScheduleInput, "rrule" | "timezone">,
  at: Date,
): string {
  const next = occurrence(input.rrule, input.timezone, at);
  if (!next || next <= at)
    invalid("RRULE must have an occurrence strictly after now");
  return next.toISOString();
}

export function scheduleJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function createScheduleHandlers(config: {
  origin: string;
  authenticate: Authenticate;
  store: ScheduleStore;
  now?: () => number;
}) {
  const now = config.now ?? Date.now;
  const store = config.store;

  async function run(
    operation: string,
    request: Request,
    mutation: boolean,
    work: (identity: Identity) => Promise<Response>,
  ): Promise<Response> {
    try {
      if (mutation && !sameOrigin(request, config.origin))
        throw new RequestError(
          403,
          "forbidden_origin",
          "Request origin is not allowed",
        );
      const identity = await config.authenticate(request);
      if (!identity)
        throw new RequestError(
          401,
          "unauthenticated",
          "Authentication required",
        );
      return await work(identity);
    } catch (error) {
      if (error instanceof RequestError)
        return scheduleJson(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      // Do not log payloads, IDs, tokens or provider diagnostics. Unexpected failures
      // are observable and returned as failures, never converted to empty results.
      console.error(
        JSON.stringify({
          level: "error",
          event: "schedule_request_failed",
          operation,
          category:
            error instanceof ScheduleStorageError ? "storage" : "unexpected",
          ...(error instanceof ScheduleStorageError
            ? { upstream_status: error.status }
            : {}),
        }),
      );
      return scheduleJson(
        {
          error: { code: "internal_error", message: "Schedule request failed" },
        },
        500,
      );
    }
  }

  async function payload(request: Request): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
      value = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) invalid("Malformed JSON");
      throw error;
    }
    return objectInput(value);
  }

  async function owned(identity: Identity, id: string): Promise<ScheduleRow> {
    if (
      typeof id !== "string" ||
      !id ||
      [...id].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      invalid("Invalid schedule ID");
    const saved = await store.get(identity.user.id, id, identity.accessToken);
    if (!saved || saved.user_id !== identity.user.id)
      throw new RequestError(404, "not_found", "Schedule not found");
    return saved;
  }

  async function forecast(
    identity: Identity,
    schedule: ScheduleRow,
    at: Date,
    status = 200,
  ) {
    const [rows, connection] = await Promise.all([
      store.list(identity.user.id, identity.accessToken),
      store.readConnection(identity.user.id, identity.accessToken),
    ]);
    // Replace by ID as well as adding a new row, so a changed schedule is counted once.
    const schedules = rows.filter(
      (row) => row.user_id === identity.user.id && row.id !== schedule.id,
    );
    schedules.push(schedule);
    const personal = connection?.is_workspace === false;
    const domain = connection?.google_email.split("@").pop()?.toLowerCase();
    const account: AccountType =
      connection?.is_workspace === true
        ? "workspace"
        : domain === "googlemail.com"
          ? "googlemail.com"
          : "gmail.com";
    const check = dailyLimitCheck(
      schedules.map((row) => ({
        status: row.status,
        rrule: row.rrule,
        timezone: row.timezone,
        to: row.to,
        cc: row.cc,
        bcc: row.bcc,
        nextSendAt: new Date(row.next_send_at),
      })),
      account,
      at,
    );
    return scheduleJson(
      {
        schedule,
        dailyLimitCheck: check,
        ...(personal && check.status !== "ok"
          ? {
              warning: `Personal Gmail daily recipient limit forecast is ${check.status} (${check.count}/${check.limit}).`,
            }
          : {}),
      },
      status,
    );
  }

  async function update(
    identity: Identity,
    id: string,
    changes: ScheduleChanges,
  ): Promise<ScheduleRow> {
    const saved = await store.update(
      identity.user.id,
      id,
      changes,
      identity.accessToken,
    );
    if (!saved) throw new RequestError(404, "not_found", "Schedule not found");
    return saved;
  }

  return {
    list: (request: Request) =>
      run("list", request, false, async (identity) =>
        scheduleJson({
          schedules: await store.list(identity.user.id, identity.accessToken),
        }),
      ),
    get: (request: Request, id: string) =>
      run("get", request, false, async (identity) =>
        scheduleJson({ schedule: await owned(identity, id) }),
      ),
    create: (request: Request) =>
      run("create", request, true, async (identity) => {
        const at = new Date(now());
        const input = normalize(await payload(request), at);
        const schedule = await store.create(
          {
            ...input,
            user_id: identity.user.id,
            status: "active",
            next_send_at: nextSend(input, at),
            created_at: at.toISOString(),
            updated_at: at.toISOString(),
          },
          identity.accessToken,
        );
        return forecast(identity, schedule, at, 201);
      }),
    patch: (request: Request, id: string) =>
      run("patch", request, true, async (identity) => {
        const original = await owned(identity, id);
        const input = await payload(request);
        const fields = editableFields.filter((field) =>
          Object.hasOwn(input, field),
        );
        if (fields.length === 0)
          invalid("At least one editable field is required");
        const provided = Object.fromEntries(
          fields.map((field) => [field, input[field]]),
        );
        const at = new Date(now());
        const normalized = normalize({ ...original, ...provided }, at);
        const changes: ScheduleChanges = {
          ...Object.fromEntries(
            fields.map((field) => [field, normalized[field]]),
          ),
          updated_at: at.toISOString(),
          ...(fields.includes("rrule") || fields.includes("timezone")
            ? { next_send_at: nextSend(normalized, at) }
            : {}),
        };
        return forecast(identity, await update(identity, id, changes), at);
      }),
    delete: (request: Request, id: string) =>
      run("delete", request, true, async (identity) => {
        await owned(identity, id);
        if (!(await store.delete(identity.user.id, id, identity.accessToken)))
          throw new RequestError(404, "not_found", "Schedule not found");
        return new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        });
      }),
    pause: (request: Request, id: string) =>
      run("pause", request, true, async (identity) => {
        await owned(identity, id);
        const schedule = await update(identity, id, {
          status: "paused",
          updated_at: new Date(now()).toISOString(),
        });
        return scheduleJson({ schedule });
      }),
    resume: (request: Request, id: string) =>
      run("resume", request, true, async (identity) => {
        const original = await owned(identity, id);
        const at = new Date(now());
        const schedule = await update(identity, id, {
          status: "active",
          next_send_at: nextSend(original, at),
          updated_at: at.toISOString(),
        });
        return forecast(identity, schedule, at);
      }),
    pauseAll: (request: Request) =>
      run("pauseAll", request, true, async (identity) =>
        scheduleJson({
          paused: await store.pauseAll(identity.user.id, identity.accessToken),
        }),
      ),
  };
}
