import sanitizeHtml from "sanitize-html";

const options: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "em", "a", "ul", "ol", "li"],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
};

export function sanitizeScheduleHtml(value: string): string {
  return sanitizeHtml(value, options);
}
