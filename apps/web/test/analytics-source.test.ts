import { describe, expect, it } from "vitest";
import {
  cleanPath,
  decodeFirstTouchCookie,
  deriveSource,
  encodeFirstTouchCookie,
  externalReferrerHost,
  type FirstTouch,
  normalizeHost,
  sanitizeFirstTouch,
  utmFromSearch,
} from "../lib/analytics-source";

describe("traffic source derivation", () => {
  it.each<[string | null, string | null, string]>([
    // A campaign tag wins and is folded onto our channel names.
    ["reddit", null, "reddit"],
    ["Twitter", null, "x"],
    ["t.co", null, "x"],
    ["x", null, "x"],
    ["hn", null, "hackernews"],
    ["news.ycombinator.com", null, "hackernews"],
    ["ph", null, "producthunt"],
    ["newsletter", null, "email"],
    ["producthunt", "reddit.com", "producthunt"],
    ["My Newsletter!", null, "my_newsletter"],
    // Otherwise the referring site decides.
    [null, "reddit.com", "reddit"],
    [null, "old.reddit.com", "reddit"],
    [null, "out.reddit.com", "reddit"],
    [null, "www.reddit.com", "reddit"],
    [null, "t.co", "x"],
    [null, "x.com", "x"],
    [null, "twitter.com", "x"],
    [null, "mobile.twitter.com", "x"],
    [null, "www.google.com", "google"],
    [null, "google.co.uk", "google"],
    [null, "google.com.au", "google"],
    [null, "bing.com", "bing"],
    [null, "duckduckgo.com", "duckduckgo"],
    [null, "search.yahoo.com", "yahoo"],
    [null, "ecosia.org", "ecosia"],
    [null, "search.brave.com", "brave"],
    [null, "news.ycombinator.com", "hackernews"],
    [null, "linkedin.com", "linkedin"],
    [null, "lnkd.in", "linkedin"],
    [null, "facebook.com", "facebook"],
    [null, "l.facebook.com", "facebook"],
    [null, "m.facebook.com", "facebook"],
    [null, "instagram.com", "instagram"],
    [null, "youtube.com", "youtube"],
    [null, "m.youtube.com", "youtube"],
    [null, "producthunt.com", "producthunt"],
    [null, "chatgpt.com", "chatgpt"],
    [null, "chat.openai.com", "chatgpt"],
    [null, "perplexity.ai", "perplexity"],
    [null, "github.com", "github"],
    [null, "mail.google.com", "email"],
    [null, "outlook.live.com", "email"],
    [null, "outlook.office.com", "email"],
    [null, "example.org", "referral"],
    [null, "blog.example.co.uk", "referral"],
    // Neither: the visitor typed the address or used a bookmark.
    [null, null, "direct"],
    ["", "", "direct"],
    ["   ", "not a host", "direct"],
  ])("utm_source %j with referrer %j is %s", (utm, referrer, expected) => {
    expect(deriveSource(utm, referrer)).toBe(expected);
  });

  it("ignores our own pages and the Google sign-in hops as referrers", () => {
    expect(
      externalReferrerHost("https://recurmail.com/", "recurmail.com"),
    ).toBeNull();
    expect(
      externalReferrerHost(
        "https://www.recurmail.com/guides/x",
        "recurmail.com",
      ),
    ).toBeNull();
    expect(
      externalReferrerHost("http://127.0.0.1:3100/", "127.0.0.1"),
    ).toBeNull();
    expect(
      externalReferrerHost("https://accounts.google.com/", "recurmail.com"),
    ).toBeNull();
    expect(
      externalReferrerHost(
        "https://www.reddit.com/r/productivity/",
        "recurmail.com",
      ),
    ).toBe("reddit.com");
    expect(
      externalReferrerHost(
        "https://News.Ycombinator.com/item?id=1",
        "recurmail.com",
      ),
    ).toBe("news.ycombinator.com");
    expect(externalReferrerHost("", "recurmail.com")).toBeNull();
    expect(externalReferrerHost("not a url", "recurmail.com")).toBeNull();
    expect(externalReferrerHost(null, "recurmail.com")).toBeNull();
  });

  it("normalizes hosts and rejects anything that is not one", () => {
    expect(normalizeHost(" WWW.Reddit.com ")).toBe("reddit.com");
    expect(normalizeHost("evil host")).toBeNull();
    expect(normalizeHost("<script>")).toBeNull();
    expect(normalizeHost(`${"a".repeat(250)}.example.com`)).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });

  it("keeps only utm parameters from a query string", () => {
    expect(
      utmFromSearch(
        "?utm_source=reddit&code=fake-secret-code&state=x&utm_medium=social&utm_campaign=launch&utm_term=&utm_content=%20",
      ),
    ).toEqual({
      utm_source: "reddit",
      utm_medium: "social",
      utm_campaign: "launch",
    });
    expect(utmFromSearch("")).toEqual({});
    expect(
      utmFromSearch(`?utm_source=${"a".repeat(300)}`).utm_source,
    ).toHaveLength(255);
  });

  it("strips query strings and fragments from paths", () => {
    expect(cleanPath("/auth/callback?code=fake-secret-code&state=x")).toBe(
      "/auth/callback",
    );
    expect(cleanPath("/#faq")).toBe("/");
    expect(cleanPath("dashboard")).toBeNull();
    expect(cleanPath(42)).toBeNull();
    expect(cleanPath(`/${"a".repeat(600)}`)).toHaveLength(512);
  });
});

describe("first-touch cookie", () => {
  const touch: FirstTouch = {
    utm_source: "reddit",
    utm_medium: "social",
    source: "reddit",
    referrer_host: "reddit.com",
    landing_path: "/guides/recurring-email-gmail",
    first_seen_at: "2026-10-16T08:00:00.000Z",
  };

  it("round-trips through base64url and survives non-ASCII campaign text", () => {
    const encoded = encodeFirstTouchCookie(touch);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFirstTouchCookie(encoded)).toEqual(touch);
    const accented = { ...touch, utm_campaign: "lancement d'été" };
    expect(decodeFirstTouchCookie(encodeFirstTouchCookie(accented))).toEqual(
      accented,
    );
  });

  it("derives the source again rather than trusting the cookie", () => {
    const forged = encodeFirstTouchCookie({ ...touch, source: "paid" });
    expect(decodeFirstTouchCookie(forged)?.source).toBe("reddit");
    const noUtm = sanitizeFirstTouch({
      referrer_host: "news.ycombinator.com",
      landing_path: "/",
      first_seen_at: touch.first_seen_at,
      source: "<img src=x>",
    });
    expect(noUtm?.source).toBe("hackernews");
  });

  it("rejects anything that does not look like what the browser wrote", () => {
    expect(decodeFirstTouchCookie(null)).toBeNull();
    expect(decodeFirstTouchCookie("not+base64url/")).toBeNull();
    expect(decodeFirstTouchCookie(btoa("not json"))).toBeNull();
    expect(decodeFirstTouchCookie(btoa("[1,2]").replace(/=/g, ""))).toBeNull();
    expect(decodeFirstTouchCookie("a".repeat(3000))).toBeNull();
    expect(sanitizeFirstTouch({ source: "reddit" })).toBeNull();
    expect(
      sanitizeFirstTouch({ landing_path: "/", first_seen_at: "yesterday" }),
    ).toBeNull();
    expect(
      sanitizeFirstTouch({
        landing_path: "javascript:alert(1)",
        first_seen_at: touch.first_seen_at,
      }),
    ).toBeNull();
  });

  it("trims and caps every free-text field", () => {
    const sanitized = sanitizeFirstTouch({
      utm_source: " reddit\u0000 ",
      utm_campaign: "x".repeat(400),
      utm_term: 42,
      referrer_host: "WWW.Reddit.com",
      landing_path: "/?utm_source=reddit#top",
      first_seen_at: "2026-10-16T08:00:00Z",
      extra: "dropped",
    });
    expect(sanitized).toEqual({
      utm_source: "reddit",
      utm_campaign: "x".repeat(255),
      source: "reddit",
      referrer_host: "reddit.com",
      landing_path: "/",
      first_seen_at: "2026-10-16T08:00:00.000Z",
    });
  });
});
