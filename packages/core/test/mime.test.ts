import { describe, expect, it } from "vitest";
import { buildMime, type MimeMessage } from "../src/index.js";

function decode64(value: string): string {
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""),
  );
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, text: string) => decode64(text));
}

function parse(raw: string) {
  const mime = decode64(raw);
  const separator = mime.indexOf("\r\n\r\n");
  const headers = mime.slice(0, separator).replace(/\r\n[ \t]+/g, " ");
  return { mime, headers, body: mime.slice(separator + 4) };
}

const message = (overrides: Partial<MimeMessage> = {}): MimeMessage => ({
  from: "sender@example.test",
  to: ["to@example.test"],
  subject: "Hello",
  text: "A message",
  date: new Date("2026-07-01T09:00:00Z"),
  ...overrides,
});

describe("buildMime", () => {
  it("returns unpadded base64url RFC 2822 data with recipient headers and CRLF", () => {
    const raw = buildMime(
      message({
        to: ["one@example.test", "two@example.test"],
        cc: ["cc@example.test"],
        bcc: ["hidden@example.test"],
      }),
    );
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const { mime, headers, body } = parse(raw);
    expect(headers).toContain("Date: Wed, 01 Jul 2026 09:00:00 GMT");
    expect(headers).toContain("From: sender@example.test");
    expect(headers).toContain("To: one@example.test, two@example.test");
    expect(headers).toContain("Cc: cc@example.test");
    expect(headers).toContain("Bcc: hidden@example.test");
    expect(headers).toContain("Subject: Hello");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headers).toContain("Content-Transfer-Encoding: base64");
    expect(decode64(body)).toBe("A message");
    expect(mime.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("encodes Unicode subject, display names, and body without losing characters", () => {
    const subject = "Résumé – 你好 🌍";
    const { headers, body } = parse(
      buildMime(
        message({
          from: { address: "sender@example.test", name: "Hassaan ✉" },
          to: [{ address: "to@example.test", name: "收件人" }],
          subject,
          text: "Hello café 🙂\nمرحبا\rnext\r\nlast",
        }),
      ),
    );
    expect(headers).toContain("=?UTF-8?B?");
    expect(decodeWords(headers)).toContain(`Subject: ${subject}`);
    expect(decodeWords(headers)).toContain(
      "From: Hassaan ✉ <sender@example.test>",
    );
    expect(decodeWords(headers)).toContain("To: 收件人 <to@example.test>");
    expect(decode64(body)).toBe("Hello café 🙂\r\nمرحبا\r\nnext\r\nlast");
    expect([...headers].every((char) => char.charCodeAt(0) <= 127)).toBe(true);
  });

  it("uses multipart/alternative with separately decodable text and HTML", () => {
    const { headers, body } = parse(
      buildMime(message({ text: "café\nplain", html: "<p>你好 🙂</p>" })),
    );
    expect(headers).toContain("Content-Type: multipart/alternative;");
    const boundary = /boundary="([^"]+)"/.exec(headers)?.[1];
    expect(boundary).toBeTruthy();
    const parts = body.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[1]).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(decode64(parts[0].split("\r\n\r\n")[1])).toBe("café\r\nplain");
    expect(decode64(parts[1].split("\r\n\r\n")[1])).toBe("<p>你好 🙂</p>");
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("supports an empty HTML alternative and Bcc-only messages", () => {
    const { headers, body } = parse(
      buildMime(
        message({ to: [], bcc: ["hidden@example.test"], text: "", html: "" }),
      ),
    );
    expect(headers).not.toMatch(/(?:^|\r\n)To:/);
    expect(headers).toContain("Bcc: hidden@example.test");
    expect(body).toContain("Content-Type: text/html;");
  });

  it("folds long encoded headers into legal encoded words without splitting UTF-8", () => {
    const subject = "你好🌍 café ".repeat(40);
    const { mime, headers } = parse(buildMime(message({ subject })));
    expect(decodeWords(headers)).toContain(`Subject: ${subject}`);
    for (const word of headers.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? []) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(decodeWords(word)).not.toContain("�");
    }
    for (const line of mime.split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(78);
  });

  it("wraps long bodies at 76 base64 characters and round-trips large content", () => {
    const text = "Hello 🙂 ".repeat(10_000);
    const { body } = parse(buildMime(message({ text })));
    for (const line of body.trim().split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(76);
    expect(decode64(body)).toBe(text);
  });

  it("quotes punctuation safely in ASCII display names", () => {
    const { headers } = parse(
      buildMime(
        message({
          from: {
            address: "sender@example.test",
            name: 'Doe, "Jane" \\ Sales',
          },
        }),
      ),
    );
    expect(headers).toContain(
      'From: "Doe, \\"Jane\\" \\\\ Sales" <sender@example.test>',
    );
  });

  it.each([
    "\r\nBcc: attacker@example.test",
    "\nInjected: yes",
    "\rInjected: yes",
    "\0hidden",
  ])("rejects header injection %j in every header input", (payload) => {
    for (const overrides of [
      { subject: `Hello${payload}` },
      { from: `sender@example.test${payload}` },
      { from: { address: "sender@example.test", name: `Name${payload}` } },
      { to: [`to@example.test${payload}`] },
      { cc: [`cc@example.test${payload}`] },
      { bcc: [`bcc@example.test${payload}`] },
      { to: [{ address: "to@example.test", name: `Name${payload}` }] },
    ])
      expect(() => buildMime(message(overrides))).toThrow(RangeError);
  });

  it("keeps apparent header and MIME injections inside encoded bodies", () => {
    const text =
      "Safe\nBcc: attacker@example.test\n\n--recurmail_alternative\nContent-Type: text/html";
    const { headers, body } = parse(buildMime(message({ text })));
    expect(headers).not.toContain("attacker");
    expect(decode64(body)).toBe(text.replace(/\n/g, "\r\n"));
    const multipart = parse(buildMime(message({ text, html: text })));
    expect(multipart.body.split("--recurmail_alternative")).toHaveLength(4);
  });

  it.each([
    "",
    "no-at-sign",
    "a@",
    "@example.test",
    "a b@example.test",
    "a@example.test,evil@example.test",
    "Display <a@example.test>",
    "ü@example.test",
    "a..b@example.test",
    "a@-example.test",
  ])("rejects malformed addresses %j", (address) => {
    expect(() => buildMime(message({ to: [address] }))).toThrow(RangeError);
  });

  it("rejects a missing recipient or invalid Date", () => {
    expect(() => buildMime(message({ to: [] }))).toThrow(/recipient/);
    expect(() => buildMime(message({ date: new Date(Number.NaN) }))).toThrow(
      /Date/,
    );
  });
});
