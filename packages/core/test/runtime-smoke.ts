// Run directly with Node's TypeScript support or `deno run --no-lock`.
// This deliberately imports the public source entry without a bundler resolver.
import {
  buildMime,
  dailyLimitCheck,
  nextOccurrence,
  presets,
} from "../src/index.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const rule =
  "DTSTART;TZID=Europe/London:20260323T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO";
assert(
  nextOccurrence(
    rule,
    "Europe/London",
    new Date("2026-03-23T09:00:00Z"),
  )?.toISOString() === "2026-03-30T08:00:00.000Z",
  "London Monday 09:00 must survive spring-forward",
);
const result = dailyLimitCheck(
  [
    {
      status: "active",
      rrule: presets.daily({ hour: 9 }),
      timezone: "Europe/London",
      to: Array.from({ length: 300 }, () => "recipient@example.test"),
    },
  ],
  "gmail.com",
  new Date("2026-03-28T00:00:00Z"),
);
assert(
  result.count === 600 && result.status === "over",
  "DST forecast must count two sends in 23 hours",
);
const raw = buildMime({
  from: "sender@example.test",
  to: ["recipient@example.test"],
  subject: "你好 🌍",
  text: "café",
  html: "<p>café</p>",
});
assert(/^[A-Za-z0-9_-]+$/.test(raw), "Gmail raw must be unpadded base64url");
const mime = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
assert(
  mime.includes("multipart/alternative") && mime.includes("=?UTF-8?B?"),
  "UTF-8 headers and HTML alternatives must be encoded",
);
let rejected = false;
try {
  buildMime({
    from: "sender@example.test",
    to: ["recipient@example.test"],
    subject: "bad\r\nBcc: attacker@example.test",
    text: "",
  });
} catch (error) {
  rejected = error instanceof RangeError;
}
assert(rejected, "Header injection must be rejected");
console.log(
  "Native runtime smoke passed: DST recurrence, rolling limits, UTF-8 MIME, injection rejection",
);
