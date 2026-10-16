import "server-only";
import { isIP } from "node:net";
import {
  type AnalyticsEventRow,
  countryOrNull,
  type EventProperties,
  isBotUserAgent,
  type RequestDetails,
  type ServerEvent,
  uuidOrNull,
  validateClientEvent,
} from "./analytics-events";
import {
  ANONYMOUS_ID_COOKIE,
  cleanText,
  decodeFirstTouchCookie,
  FIRST_TOUCH_COOKIE,
  SESSION_ID_COOKIE,
} from "./analytics-source";
import { type AnalyticsStore, attributionFrom } from "./analytics-store";
import { readCookie, sameOrigin } from "./http";

/**
 * Recording from the route handlers. Every method swallows its own failures:
 * a schedule must save and a sign-in must finish whether or not the event
 * about it was written.
 */
export interface ServerAnalytics {
  track(
    request: Request,
    event: ServerEvent,
    input?: {
      userId?: string | null;
      userEmail?: string | null;
      properties?: EventProperties;
    },
  ): Promise<void>;
  /**
   * Gives a user their first-touch attribution row from the browser's
   * cookies, unless they already have one. Returns whether the row was
   * created by this call.
   */
  recordSignup(
    request: Request,
    user: { id: string; email: string },
    signedUpAt?: string,
  ): Promise<boolean>;
}

const MAX_BODY = 8192;

/** The client address Vercel forwards: the first x-forwarded-for entry, else x-real-ip. */
function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  const candidate = (
    forwarded?.trim() ||
    request.headers.get("x-real-ip") ||
    ""
  )
    .trim()
    .replace(/^\[(.*)\]$/, "$1");
  return isIP(candidate) ? candidate : null;
}

/** A Vercel geo header, which arrives URI-encoded. */
function geoHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (!value) return null;
  try {
    return cleanText(decodeURIComponent(value), 255);
  } catch {
    return cleanText(value, 255);
  }
}

/** Everything the server records about the request itself. */
export function requestDetails(request: Request): RequestDetails {
  const userAgent = request.headers.get("user-agent");
  return {
    ip_address: clientAddress(request),
    user_agent: cleanText(userAgent, 1024),
    accept_language: cleanText(request.headers.get("accept-language"), 255),
    country: countryOrNull(request.headers.get("x-vercel-ip-country")),
    region: geoHeader(request, "x-vercel-ip-country-region"),
    city: geoHeader(request, "x-vercel-ip-city"),
    is_bot: isBotUserAgent(userAgent),
  };
}

/** The page the request was sent from, when it was one of ours. */
function sourcePath(request: Request, origin: string): string | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.origin === origin ? url.pathname.slice(0, 512) : null;
  } catch {
    return null;
  }
}

export function createServerAnalytics(config: {
  origin: string;
  store: AnalyticsStore;
  now?: () => number;
}): ServerAnalytics {
  const now = config.now ?? Date.now;
  return {
    async track(request, event, input = {}) {
      try {
        const row: AnalyticsEventRow = {
          event,
          anonymous_id: uuidOrNull(readCookie(request, ANONYMOUS_ID_COOKIE)),
          session_id: uuidOrNull(readCookie(request, SESSION_ID_COOKIE)),
          user_id: input.userId ?? null,
          user_email: cleanText(input.userEmail, 320),
          path: sourcePath(request, config.origin),
          referrer_host: null,
          source: null,
          device: null,
          ...requestDetails(request),
          properties: input.properties ?? {},
        };
        await config.store.insertEvent(row);
      } catch {
        console.error("[ERROR] analytics_track_failed");
      }
    },
    async recordSignup(request, user, signedUpAt) {
      try {
        if (await config.store.hasAttribution(user.id)) return false;
        const details = requestDetails(request);
        await config.store.insertAttribution({
          ...attributionFrom(
            user.id,
            uuidOrNull(readCookie(request, ANONYMOUS_ID_COOKIE)),
            decodeFirstTouchCookie(readCookie(request, FIRST_TOUCH_COOKIE)),
            signedUpAt ?? new Date(now()).toISOString(),
          ),
          user_email: cleanText(user.email, 320),
          signup_ip: details.ip_address,
          signup_user_agent: details.user_agent,
        });
        return true;
      } catch {
        console.error("[ERROR] analytics_attribution_failed");
        return false;
      }
    },
  };
}

/**
 * The user inside a Supabase access token. The token only ever comes out of
 * the session cookie, which is sealed with the server key and holds only
 * tokens Supabase issued, so its claims can be read without another round
 * trip to Supabase. A token that is not a JWT yields no user.
 */
export function tokenIdentity(
  accessToken: string | undefined,
): { id: string; email: string | null } | null {
  const parts = accessToken?.split(".") ?? [];
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    const id = uuidOrNull(payload?.sub);
    return id ? { id, email: cleanText(payload?.email, 320) } : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/events. Accepts one browser event per request from our own
 * pages, validates every field, attaches what only the server knows (the
 * user, the request details) and answers 204. Storage failures are logged
 * and still answered 204: the browser has nothing useful to do with them.
 */
export function createEventsHandler(config: {
  origin: string;
  store: AnalyticsStore;
  identity: (request: Request) => { id: string; email: string | null } | null;
}) {
  const noContent = () =>
    new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  const reject = (status: number, message: string) =>
    new Response(message, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  return async function record(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      });
    if (!sameOrigin(request, config.origin))
      return reject(403, "Request origin is not allowed");
    let text: string;
    try {
      text = await request.text();
    } catch {
      return reject(400, "Event body is required");
    }
    if (text.length > MAX_BODY) return reject(413, "Event body is too large");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return reject(400, "Malformed JSON");
    }
    const event = validateClientEvent(value);
    if (!event) return reject(400, "Invalid event");
    try {
      const user = config.identity(request);
      await config.store.insertEvent({
        ...event,
        user_id: user?.id ?? null,
        user_email: user?.email ?? null,
        ...requestDetails(request),
      });
    } catch {
      console.error("[ERROR] analytics_insert_failed");
    }
    return noContent();
  };
}
