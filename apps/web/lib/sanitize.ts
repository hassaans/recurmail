import sanitizeHtml from "sanitize-html";

const options: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "a", "ul", "ol", "li"],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Browsers' rich-text editing writes <b>, <i> and a <div> per line; keep that
  // formatting as the allowed equivalents instead of discarding it.
  transformTags: { b: "strong", i: "em", div: "p" },
};

export function sanitizeScheduleHtml(value: string): string {
  return sanitizeHtml(value, options);
}
