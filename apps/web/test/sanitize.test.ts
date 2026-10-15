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

  it("keeps editor bold and italic as strong and em", () => {
    expect(
      sanitizeScheduleHtml('Plain <b style="x">bold</b> and <i>italic</i>'),
    ).toBe("Plain <strong>bold</strong> and <em>italic</em>");
  });

  it("keeps the line breaks the editor writes as divs", () => {
    expect(
      sanitizeScheduleHtml(
        'Line one<div>Line two <i>here</i></div><div><br></div><div class="x">Line four</div>',
      ),
    ).toBe(
      "Line one<p>Line two <em>here</em></p><p><br /></p><p>Line four</p>",
    );
  });
});
