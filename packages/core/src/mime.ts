export interface NamedMailbox {
  address: string;
  name?: string;
}

/** Strings are bare addresses; use an object for a display name. */
export type Mailbox = string | NamedMailbox;

export interface MimeMessage {
  from: Mailbox;
  to?: readonly Mailbox[];
  cc?: readonly Mailbox[];
  bcc?: readonly Mailbox[];
  subject: string;
  text: string;
  html?: string;
  date?: Date;
}

const CRLF = "\r\n";
const encoder = new TextEncoder();

function headerValue(value: string): void {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw new RangeError("Header values must not contain control characters");
    }
  }
}

function base64(value: string): string {
  const bytes = encoder.encode(value);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(""));
}

/** RFC 2047 encoded words, split only at UTF-8 code point boundaries. */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > 45) {
      words.push(`=?UTF-8?B?${base64(chunk)}?=`);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join(" ");
}

function mailbox(value: Mailbox): string {
  const { address, name } =
    typeof value === "string" ? { address: value, name: undefined } : value;
  headerValue(address);
  const parts = address.split("@");
  if (
    parts.length !== 2 ||
    address.length > 254 ||
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
  ) {
    throw new RangeError("Invalid mailbox address; use a bare ASCII address");
  }
  if (name === undefined || name === "") return address;
  headerValue(name);
  const display =
    /[^\x20-\x7e]/.test(name) || name.length > 60
      ? encodedWords(name)
      : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  return `${display} <${address}>`;
}

function foldHeader(name: string, value: string): string {
  let line = `${name}:`;
  const lines: string[] = [];
  for (const word of value.split(" ")) {
    if (line.length + word.length + 1 > 78) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

function body(value: string): string {
  const encoded = base64(value.replace(/\r\n|\r|\n/g, CRLF));
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? "";
}

/** RFC 2822/MIME message as the unpadded base64url `raw` for Gmail send. */
export function buildMime(message: MimeMessage): string {
  headerValue(message.subject);
  const date = message.date ?? new Date();
  if (!Number.isFinite(date.getTime()))
    throw new RangeError("Invalid message Date");
  const recipients =
    (message.to?.length ?? 0) +
    (message.cc?.length ?? 0) +
    (message.bcc?.length ?? 0);
  if (recipients === 0)
    throw new RangeError("At least one recipient is required");
  const headers = [
    `Date: ${date.toUTCString()}`,
    foldHeader("From", mailbox(message.from)),
  ];
  for (const [name, values] of [
    ["To", message.to],
    ["Cc", message.cc],
    ["Bcc", message.bcc],
  ] as const) {
    if (values?.length)
      headers.push(foldHeader(name, values.map(mailbox).join(", ")));
  }
  const subject =
    /[^\x20-\x7e]/.test(message.subject) || message.subject.length > 60
      ? encodedWords(message.subject)
      : message.subject;
  headers.push(foldHeader("Subject", subject), "MIME-Version: 1.0");
  let content: string;
  if (message.html === undefined) {
    headers.push(
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    );
    content = body(message.text);
  } else {
    // '_' cannot occur in base64 parts, so this boundary cannot collide with them.
    const boundary = "recurmail_alternative";
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    content = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      body(message.text),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      body(message.html),
      `--${boundary}--`,
    ].join(CRLF);
  }
  return base64(`${headers.join(CRLF)}${CRLF}${CRLF}${content}${CRLF}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
