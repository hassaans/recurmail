import { buildMime } from "@recurmail/core";

export class GmailError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "known" | "unknown" | "invalid_grant" | "defer",
    message = code,
  ) {
    super(message);
  }
}

export type GmailSchedule = {
  user_id: string;
  google_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
};

export async function sendSchedule(
  schedule: GmailSchedule,
  refreshToken: string,
  config: { clientId: string; clientSecret: string; fetcher?: typeof fetch },
): Promise<string> {
  const fetcher = config.fetcher ?? fetch;
  const tokenResponse = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  }).catch((error: unknown) => {
    throw new GmailError(
      "oauth_transport_error",
      "known",
      error instanceof Error ? error.message : "OAuth transport error",
    );
  });

  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (tokenBody.error === "invalid_grant")
    throw new GmailError("invalid_grant", "invalid_grant");
  if (!tokenResponse.ok || typeof tokenBody.access_token !== "string") {
    throw new GmailError(
      `oauth_${String(tokenBody.error ?? tokenResponse.status)}`,
      "known",
    );
  }

  const raw = buildMime({
    from: schedule.google_email,
    to: schedule.to,
    cc: schedule.cc,
    bcc: schedule.bcc,
    subject: schedule.subject,
    text: schedule.body_text,
    ...(schedule.body_html === null ? {} : { html: schedule.body_html }),
  });

  let response: Response;
  try {
    response = await fetcher(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ raw }),
      },
    );
  } catch (error) {
    throw new GmailError(
      "gmail_send_outcome_unknown",
      "unknown",
      error instanceof Error
        ? error.message
        : "Gmail transport failed after request dispatch",
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    if (response.status === 429)
      throw new GmailError("gmail_quota_deferred", "defer");
    if (response.status >= 500)
      throw new GmailError(`gmail_${response.status}`, "unknown");
    if (!response.ok) throw new GmailError(`gmail_${response.status}`, "known");
    throw new GmailError("gmail_send_response_invalid", "unknown");
  }
  const error = body.error as Record<string, unknown> | string | undefined;
  const status =
    typeof error === "object" && error
      ? Number(error.code ?? response.status)
      : response.status;
  const reasons =
    typeof error === "object" && error && Array.isArray(error.errors)
      ? error.errors.map((item: { reason?: unknown }) =>
          String(item.reason ?? ""),
        )
      : [];
  const code =
    status === 429 ||
    (status === 403 &&
      reasons.some((reason) =>
        /rateLimit|userRateLimit|dailyLimit|quota/i.test(reason),
      ))
      ? "gmail_quota_deferred"
      : `gmail_${status}`;

  if (status === 429 || code === "gmail_quota_deferred")
    throw new GmailError(code, "defer");
  if (status >= 500) throw new GmailError(code, "unknown");
  if (!response.ok) throw new GmailError(code, "known");
  if (typeof body.id !== "string")
    throw new GmailError("gmail_send_response_invalid", "unknown");
  return body.id;
}
