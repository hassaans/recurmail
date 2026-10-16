import {
  cleanPath,
  cleanUtmValue,
  deriveSource,
  normalizeHost,
  stripControl,
  UTM_FIELDS,
  type UtmFields,
} from "./analytics-source";

/** Events the browser may report. Everything else is recorded server-side. */
export const CLIENT_EVENTS = [
  "page_view",
  "cta_click",
  "signup_started",
  "login_click",
  "nav_menu_opened",
  "faq_opened",
  "guide_link_click",
  "outbound_link_click",
  "support_email_click",
  "scroll_depth",
  "editor_opened",
  "connect_gmail_click",
  "reconnect_gmail_click",
  "add_gmail_account_click",
  "new_schedule_click",
] as const;

/** Events the route handlers record, with the user attached. */
export const SERVER_EVENTS = [
  "signup_completed",
  "login_completed",
  "signed_out",
  "gmail_connect_started",
  "gmail_connected",
  "gmail_connect_denied",
  "gmail_connect_failed",
  "gmail_disconnected",
  "schedule_created",
  "schedule_updated",
  "schedule_paused",
  "schedule_resumed",
  "schedule_deleted",
  "schedules_paused_all",
  "test_email_sent",
  "test_email_failed",
  "account_deleted",
] as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[number];
export type ServerEvent = (typeof SERVER_EVENTS)[number];
export type EventName = ClientEvent | ServerEvent;

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];

/** Short facts about an action: a frequency, a count bucket, a label. Never content or addresses. */
export type EventProperties = Record<string, string | number | boolean>;

const MAX_PROPERTIES = 12;
const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PROPERTY_LENGTH = 200;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the server saw of the request that carried an event. */
export interface RequestDetails {
  ip_address: string | null;
  user_agent: string | null;
  accept_language: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  is_bot: boolean;
}

export interface AnalyticsEventRow extends UtmFields, RequestDetails {
  event: EventName;
  anonymous_id: string | null;
  session_id: string | null;
  user_id: string | null;
  user_email: string | null;
  path: string | null;
  referrer_host: string | null;
  source: string | null;
  device: Device | null;
  properties: EventProperties;
}

export function isClientEvent(value: unknown): value is ClientEvent {
  return (
    typeof value === "string" &&
    (CLIENT_EVENTS as readonly string[]).includes(value)
  );
}

export function uuidOrNull(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}

/** A two-letter country from Vercel's edge header; anything else is unknown. */
export function countryOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null;
}

/**
 * Properties as a small flat object, or null when the shape is wrong. A
 * wrong shape rejects the whole event: the browser code never sends one, so
 * it is a sign of something other than our page talking to the route.
 */
export function cleanProperties(value: unknown): EventProperties | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROPERTIES) return null;
  const properties: EventProperties = {};
  for (const [key, raw] of entries) {
    if (!PROPERTY_KEY.test(key)) return null;
    if (typeof raw === "boolean") properties[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw))
      properties[key] = raw;
    else if (typeof raw === "string") {
      if (raw.length > MAX_PROPERTY_LENGTH || stripControl(raw) !== raw)
        return null;
      properties[key] = raw;
    } else return null;
  }
  return properties;
}

/**
 * A browser event payload checked field by field. The source is derived here
 * from the campaign tag and referrer rather than taken from the payload, so
 * the stored channel names are always ours.
 */
export function validateClientEvent(
  value: unknown,
): Omit<
  AnalyticsEventRow,
  "user_id" | "user_email" | keyof RequestDetails
> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isClientEvent(input.event)) return null;
  const properties = cleanProperties(input.properties);
  if (!properties) return null;
  if (
    input.anonymous_id !== undefined &&
    input.anonymous_id !== null &&
    !uuidOrNull(input.anonymous_id)
  )
    return null;
  if (
    input.session_id !== undefined &&
    input.session_id !== null &&
    !uuidOrNull(input.session_id)
  )
    return null;
  if (
    input.device !== undefined &&
    input.device !== null &&
    !(DEVICES as readonly unknown[]).includes(input.device)
  )
    return null;
  const utm: UtmFields = {};
  for (const field of UTM_FIELDS) {
    const cleaned = cleanUtmValue(input[field]);
    if (cleaned) utm[field] = cleaned;
  }
  const referrer_host = normalizeHost(
    typeof input.referrer_host === "string" ? input.referrer_host : null,
  );
  return {
    event: input.event,
    anonymous_id: uuidOrNull(input.anonymous_id),
    session_id: uuidOrNull(input.session_id),
    path: cleanPath(input.path),
    referrer_host,
    source: deriveSource(utm.utm_source, referrer_host),
    ...utm,
    device: (input.device as Device | undefined) ?? null,
    properties,
  };
}

/**
 * Crawlers and scripted clients, which never sign up. Their events are kept
 * but flagged, so the summary can leave them out. Browser tests run a real
 * Chromium whose user agent does not match any of these.
 */
const BOT_AGENT =
  /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|preview|facebookexternalhit|embedly|quora link|outbrain|vkshare|w3c_validator|curl\/|wget\/|python|java\/|go-http|okhttp|node-fetch|axios|undici/i;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_AGENT.test(userAgent);
}
