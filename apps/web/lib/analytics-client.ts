// Browser-only. Keeps the visitor's ids and first touch in the browser and
// reports events to our own /api/events route. Nothing here throws: storage
// can be blocked and the route can be down without the page noticing.
import {
  CLIENT_EVENTS,
  type ClientEvent,
  type Device,
  type EventProperties,
} from "./analytics-events";
import {
  ANONYMOUS_ID_COOKIE,
  cleanPath,
  deriveSource,
  encodeFirstTouchCookie,
  externalReferrerHost,
  FIRST_TOUCH_COOKIE,
  type FirstTouch,
  SESSION_ID_COOKIE,
  sanitizeFirstTouch,
  type UtmFields,
  utmFromSearch,
} from "./analytics-source";

export const ANONYMOUS_ID_KEY = "rm_aid";
export const FIRST_TOUCH_KEY = "rm_first_touch";
export const LAST_TOUCH_KEY = "rm_last_touch";
export const SESSION_KEY = "rm_session";
export const EVENTS_PATH = "/api/events";
const SESSION_IDLE = 30 * 60_000;
const YEAR = 365 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the current page load came from. */
export interface Landing extends UtmFields {
  source: string;
  referrer_host: string | null;
}

interface Session extends Landing {
  id: string;
  /** Last activity, epoch milliseconds. */
  last: number;
}

function storage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function read(kind: "localStorage" | "sessionStorage", key: string): unknown {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(
  kind: "localStorage" | "sessionStorage",
  key: string,
  value: unknown,
): void {
  try {
    storage(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked; the visit is still reported.
  }
}

function setCookie(name: string, value: string, maxAge: number): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: cookieStore is not in every browser we serve.
    document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${
      location.protocol === "https:" ? "; Secure" : ""
    }`;
  } catch {
    // Cookies blocked; local storage still carries the ids.
  }
}

function cookie(name: string): string | null {
  try {
    for (const part of document.cookie.split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
    }
  } catch {
    // Cookies blocked.
  }
  return null;
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// The id for this page load, so a browser that blocks local storage keeps
// one id across its events instead of getting a new one per call.
let pageAnonymousId: string | null = null;

/**
 * The browser's random id, created on first use and mirrored to a cookie for
 * the server. Local storage is the record; without it the id this page
 * already used, then the cookie from an earlier page, stand in.
 */
export function anonymousId(): string {
  const saved = read("localStorage", ANONYMOUS_ID_KEY);
  if (typeof saved === "string" && UUID.test(saved)) {
    pageAnonymousId = saved;
    return saved;
  }
  const fromCookie = cookie(ANONYMOUS_ID_COOKIE);
  const id =
    pageAnonymousId ??
    (fromCookie && UUID.test(fromCookie) ? fromCookie : uuid());
  pageAnonymousId = id;
  write("localStorage", ANONYMOUS_ID_KEY, id);
  return id;
}

/** How the current page was reached, from the referrer and the address bar. */
export function landingFrom(
  referrer: string,
  search: string,
  ownHost: string,
): Landing {
  const utm = utmFromSearch(search);
  const referrer_host = externalReferrerHost(referrer, ownHost);
  return {
    ...utm,
    referrer_host,
    source: deriveSource(utm.utm_source, referrer_host),
  };
}

// The landing of this page load, kept for a session that starts later on
// the same page (after half an hour idle).
let pageLanding: Landing = { source: "direct", referrer_host: null };

// This page load's session, for a browser that blocks session storage.
let pageSession: Session | null = null;

/**
 * The current session, renewed on use. Session storage is the record;
 * without it the session this page already used, then the rm_sid cookie
 * (which lapses after the same 30 idle minutes), carry the id. A session
 * picked up from the cookie alone takes this page's landing as its source.
 */
function session(now: number, landing: Landing | null): Session {
  const fromCookie = cookie(SESSION_ID_COOKIE);
  const saved =
    (read("sessionStorage", SESSION_KEY) as Session | null) ??
    pageSession ??
    (fromCookie && UUID.test(fromCookie)
      ? { ...pageLanding, id: fromCookie, last: now }
      : null);
  const current =
    saved &&
    typeof saved.id === "string" &&
    UUID.test(saved.id) &&
    typeof saved.last === "number" &&
    now - saved.last < SESSION_IDLE &&
    // A fresh campaign or referral starts a new session even mid-visit, so
    // the source of every event in it is the one that brought them back.
    !(landing && landing.source !== "direct")
      ? { ...saved, last: now }
      : { ...(landing ?? pageLanding), id: uuid(), last: now };
  pageSession = current;
  write("sessionStorage", SESSION_KEY, current);
  setCookie(SESSION_ID_COOKIE, current.id, SESSION_IDLE / 1000);
  return current;
}

function device(): Device {
  const data = (
    navigator as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData;
  if (data?.mobile) return "mobile";
  const width = window.innerWidth;
  const touch = navigator.maxTouchPoints > 0;
  if (width < 768) return "mobile";
  if (
    (width < 1024 && touch) ||
    /iPad|Android(?!.*Mobile)/i.test(navigator.userAgent)
  )
    return "tablet";
  return "desktop";
}

function send(payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  try {
    // A string body is sent as text/plain, which sendBeacon always allows.
    if (navigator.sendBeacon?.(EVENTS_PATH, body)) return;
  } catch {
    // Fall through to fetch.
  }
  try {
    void fetch(EVENTS_PATH, {
      method: "POST",
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Nothing to do.
  }
}

/**
 * Runs once per page load: settles the browser id and its cookie, records
 * the first touch if this is the first visit, notes the latest campaign,
 * and starts or continues the session.
 */
export function startVisit(): void {
  const now = Date.now();
  const id = anonymousId();
  setCookie(ANONYMOUS_ID_COOKIE, id, YEAR);
  pageLanding = landingFrom(
    document.referrer,
    location.search,
    location.hostname,
  );
  let first = sanitizeFirstTouch(read("localStorage", FIRST_TOUCH_KEY));
  if (!first) {
    const { source, referrer_host, ...utm } = pageLanding;
    first = {
      ...utm,
      source,
      referrer_host,
      landing_path: cleanPath(location.pathname) ?? "/",
      first_seen_at: new Date(now).toISOString(),
    };
    write("localStorage", FIRST_TOUCH_KEY, first);
  }
  // The cookie is what the server reads at sign-up, so it is re-mirrored
  // whenever it has gone missing (cleared cookies, expiry).
  if (cookie(FIRST_TOUCH_COOKIE) === null)
    setCookie(FIRST_TOUCH_COOKIE, encodeFirstTouchCookie(first), YEAR);
  if (pageLanding.source !== "direct") {
    const { source, referrer_host, ...utm } = pageLanding;
    const last: FirstTouch = {
      ...utm,
      source,
      referrer_host,
      landing_path: location.pathname,
      first_seen_at: new Date(now).toISOString(),
    };
    write("localStorage", LAST_TOUCH_KEY, last);
  }
  session(now, pageLanding);
}

/** Reports one event. Safe to call before startVisit; ids are created on demand. */
export function track(
  event: ClientEvent,
  properties: EventProperties = {},
): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    const { id, last: _last, ...landing } = session(now, null);
    const { source, referrer_host, ...utm } = landing;
    send({
      event,
      anonymous_id: anonymousId(),
      session_id: id,
      // The path only: query strings can carry OAuth codes.
      path: location.pathname,
      referrer_host,
      ...utm,
      source,
      device: device(),
      properties,
    });
  } catch {
    // Never let reporting break the page.
  }
}

function isClientEvent(value: string | undefined): value is ClientEvent {
  return (
    value !== undefined && (CLIENT_EVENTS as readonly string[]).includes(value)
  );
}

/** `data-track-location="hero"` becomes `{ location: "hero" }`. */
function datasetProperties(element: HTMLElement): EventProperties {
  const properties: EventProperties = {};
  for (const [key, value] of Object.entries(element.dataset)) {
    if (key === "track" || key === "trackToggle" || !key.startsWith("track"))
      continue;
    const name = key.slice("track".length);
    if (value !== undefined)
      properties[name.charAt(0).toLowerCase() + name.slice(1)] = value;
  }
  return properties;
}

/**
 * The events a click stands for. An element (or ancestor) with `data-track`
 * names its own event. On top of that, a link to sign-in is a sign-up start
 * unless it is marked `data-track-intent="login"` (a returning user signing
 * back in), a mailto link a support click, a link to another site an
 * outbound click, and a link into the guides a guide click, so the markup
 * only has to label the calls to action.
 */
export function clickEvents(
  target: Element,
  ownOrigin: string,
): [ClientEvent, EventProperties][] {
  const events: [ClientEvent, EventProperties][] = [];
  const tracked = target.closest<HTMLElement>("[data-track]");
  const explicit = tracked?.dataset.track;
  const properties = tracked ? datasetProperties(tracked) : {};
  if (isClientEvent(explicit)) events.push([explicit, properties]);
  const summary = target.closest("summary");
  const details = summary?.parentElement;
  if (
    details instanceof HTMLDetailsElement &&
    !details.open &&
    isClientEvent(details.dataset.trackToggle)
  )
    events.push([details.dataset.trackToggle, datasetProperties(details)]);
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return events;
  const href = anchor.getAttribute("href") ?? "";
  if (href.startsWith("mailto:")) {
    if (!explicit) events.push(["support_email_click", properties]);
    return events;
  }
  let url: URL;
  try {
    url = new URL(href, ownOrigin);
  } catch {
    return events;
  }
  if (url.origin !== ownOrigin) {
    if (!explicit && /^https?:$/.test(url.protocol))
      events.push([
        "outbound_link_click",
        { ...properties, host: url.hostname },
      ]);
    return events;
  }
  if (url.pathname === "/auth/signin") {
    if (anchor.dataset.trackIntent !== "login")
      events.push(["signup_started", properties]);
  } else if (url.pathname.startsWith("/guides/") && !explicit)
    events.push(["guide_link_click", { ...properties, path: url.pathname }]);
  return events;
}

/**
 * Reports how far down a long page the visitor read, at 25, 50, 75 and
 * 100 percent, once each. Returns the function that stops watching.
 */
export function watchScrollDepth(): () => void {
  const reached = new Set<number>();
  const check = () => {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    const depth =
      total <= 0
        ? 100
        : Math.min(100, Math.round((window.scrollY / total) * 100));
    for (const mark of [25, 50, 75, 100])
      if (depth >= mark && !reached.has(mark)) {
        reached.add(mark);
        track("scroll_depth", { depth: mark });
      }
  };
  window.addEventListener("scroll", check, { passive: true });
  check();
  return () => window.removeEventListener("scroll", check);
}
