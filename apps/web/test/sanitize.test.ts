import { describe, expect, it } from "vitest";
import { sanitizeScheduleHtml } from "../lib/sanitize";

describe("schedule HTML sanitization", () => {
  it("removes script tags and their contents", () => {
    expect(sanitizeScheduleHtml("<p>Hello</p><script>alert(1)</script>")).toBe(
      "<p>Hello</p>",
    );
  });

  it("removes event handler attributes", () => {
    expect(sanitizeScheduleHtml('<img src="x" onerror="alert(1)">Hello')).toBe(
      "Hello",
    );
  });

  it("removes javascript links while retaining allowed link text", () => {
    expect(
      sanitizeScheduleHtml('<a href="javascript:alert(1)">click</a>'),
    ).toBe("<a>click</a>");
  });
});
