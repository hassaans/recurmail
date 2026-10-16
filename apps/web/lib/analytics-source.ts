// Shared by the browser and the server: both must agree on how a visit is
// attributed, so the first-touch cookie written in the browser and the
// summary the admin page reads use the same channel names.

export const ANONYMOUS_ID_COOKIE = "rm_aid";
export const SESSION_ID_COOKIE = "rm_sid";
export const FIRST_TOUCH_COOKIE = "rm_ft";
export const UTM_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export type UtmField = (typeof UTM_FIELDS)[number];
export type UtmFields = Partial<Record<UtmField, string>>;

export interface FirstTouch extends UtmFields {
  source: string;
  referrer_host: string | null;
  landing_path: string;
  first_seen_at: string;
}

/** Hosts that are RecurMail itself; a referrer from one of these is not a source. */
const OWN_HOSTS = new Set(["recurmail.com", "www.recurmail.com"]);
/**
 * Referrers that are a step in one of our own flows, not where the visitor
 * came from: Google sign-in and Gmail consent return the browser to the
 * dashboard with accounts.google.com as the referrer.
 */
const PASS_THROUGH_HOSTS = new Set(["accounts.google.com"]);

const UTM_SOURCE_ALIASES: Record<string, string> = {
  twitter: "x",
  "twitter.com": "x",
  x: "x",
  "x.com": "x",
  "t.co": "x",
  reddit: "reddit",
  "reddit.com": "reddit",
  hn: "hackernews",
  hackernews: "hackernews",
  "hacker-news": "hackernews",
  "news.ycombinator.com": "hackernews",
  ycombinator: "hackernews",
  producthunt: "producthunt",
  "product-hunt": "producthunt",
  ph: "producthunt",
  linkedin: "linkedin",
  "linkedin.com": "linkedin",
  facebook: "facebook",
  fb: "facebook",
  "facebook.com": "facebook",
  instagram: "instagram",
  ig: "instagram",
  youtube: "youtube",
  "youtube.com": "youtube",
  google: "google",
  chatgpt: "chatgpt",
  openai: "chatgpt",
  perplexity: "perplexity",
  github: "github",
  email: "email",
  newsletter: "email",
  mail: "email",
};

const REFERRER_HOSTS: Record<string, string> = {
  "reddit.com": "reddit",
  "t.co": "x",
  "x.com": "x",
  "twitter.com": "x",
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "yahoo.com": "yahoo",
  "search.yahoo.com": "yahoo",
  "ecosia.org": "ecosia",
  "search.brave.com": "brave",
  "news.ycombinator.com": "hackernews",
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "facebook.com": "facebook",
  "instagram.com": "instagram",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "producthunt.com": "producthunt",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "perplexity.ai": "perplexity",
  "github.com": "github",
  "mail.google.com": "email",
  "mail.yahoo.com": "email",
  "mail.proton.me": "email",
};

const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** A lowercased hostname with a leading "www." removed, or null when it is not a hostname. */
export function normalizeHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return host && host.length <= 255 && HOST_PATTERN.test(host) ? host : null;
}

/**
 * The host of a referring page when it is another site. Our own pages, the
 * app's own origin and the Google sign-in hops in between count as no
 * referrer. `ownHost` is the browser's current host.
 */
export function externalReferrerHost(
  referrer: string | null | undefined,
  ownHost?: string,
): string | null {
  if (!referrer) return null;
  let host: string | null;
  try {
    host = normalizeHost(new URL(referrer).hostname);
  } catch {
    return null;
  }
  if (!host) return null;
  const own = normalizeHost(ownHost ?? null);
  if (host === own || OWN_HOSTS.has(host) || PASS_THROUGH_HOSTS.has(host))
    return null;
  return host;
}

function matchHost(host: string, table: Record<string, string>): string | null {
  // Exact host first, then each parent domain, so old.reddit.com and
  // out.reddit.com map like reddit.com, and l.facebook.com like facebook.com.
  const labels = host.split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join(".");
    if (candidate in table) return table[candidate];
  }
  return null;
}

/** The channel a referrer host belongs to; any other site is a referral. */
export function sourceFromReferrerHost(host: string | null): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const known = matchHost(normalized, REFERRER_HOSTS);
  if (known) return known;
  // google.com, google.co.uk, google.com.au and so on, but not a Google
  // product on its own subdomain (those are listed explicitly above).
  const labels = normalized.split(".");
  if (
    labels[0] === "google" ||
    (labels.length >= 2 && labels[0] === "www" && labels[1] === "google")
  )
    return "google";
  if (labels.length >= 2 && labels[0] === "outlook") return "email";
  return "referral";
}

/** A campaign's own name for where it ran, folded onto our channel names. */
export function normalizeUtmSource(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!cleaned) return null;
  return UTM_SOURCE_ALIASES[cleaned] ?? cleaned;
}

/**
 * Where a visit came from. A campaign tag names the source outright;
 * otherwise the referring site decides; with neither, the visitor typed the
 * address or used a bookmark.
 */
export function deriveSource(
  utmSource: string | null | undefined,
  referrerHost: string | null | undefined,
): string {
  return (
    normalizeUtmSource(utmSource) ??
    sourceFromReferrerHost(referrerHost ?? null) ??
    "direct"
  );
}

/** Removes ASCII control characters; `space` also removes whitespace. */
export function stripControl(value: string, space = false): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (space ? code > 32 : code >= 32) && code !== 127;
    })
    .join("");
}

/** A short free-text value, trimmed and cut to the column width. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripControl(value).trim().slice(0, max);
  return cleaned || null;
}

/** A free-text campaign value, trimmed and cut to the column width. */
export function cleanUtmValue(value: unknown): string | null {
  return cleanText(value, 255);
}

/** The utm_* parameters of a query string; every other parameter is ignored. */
export function utmFromSearch(search: string): UtmFields {
  const fields: UtmFields = {};
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return fields;
  }
  for (const field of UTM_FIELDS) {
    const value = cleanUtmValue(params.get(field));
    if (value) fields[field] = value;
  }
  return fields;
}

/** A page path without its query string or fragment, cut to the column width. */
export function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = stripControl(value.split(/[?#]/)[0], true);
  return path.startsWith("/") ? path.slice(0, 512) : null;
}

/**
 * A first-touch record from storage or a cookie, keeping only fields that
 * look like what we wrote. Anything malformed becomes null, so a tampered
 * cookie cannot put arbitrary text in the attribution table.
 */
export function sanitizeFirstTouch(value: unknown): FirstTouch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const landing_path = cleanPath(record.landing_path);
  const first_seen_at =
    typeof record.first_seen_at === "string" &&
    !Number.isNaN(Date.parse(record.first_seen_at))
      ? new Date(record.first_seen_at).toISOString()
      : null;
  if (!landing_path || !first_seen_at) return null;
  const referrer_host = normalizeHost(
    typeof record.referrer_host === "string" ? record.referrer_host : null,
  );
  const utm: UtmFields = {};
  for (const field of UTM_FIELDS) {
    const cleaned = cleanUtmValue(record[field]);
    if (cleaned) utm[field] = cleaned;
  }
  return {
    ...utm,
    // The source is derived again rather than trusted from the cookie.
    source: deriveSource(utm.utm_source, referrer_host),
    referrer_host,
    landing_path,
    first_seen_at,
  };
}

/** Decodes the rm_ft cookie (base64url JSON) into a sanitized first touch. */
export function decodeFirstTouchCookie(
  value: string | null | undefined,
): FirstTouch | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return sanitizeFirstTouch(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** Encodes a first touch for the rm_ft cookie (base64url JSON, UTF-8 safe). */
export function encodeFirstTouchCookie(touch: FirstTouch): string {
  const bytes = new TextEncoder().encode(JSON.stringify(touch));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
