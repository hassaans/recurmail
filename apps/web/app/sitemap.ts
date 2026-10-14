import type { MetadataRoute } from "next";

const siteUrl = "https://recurmail.com";
const lastModified = new Date("2026-10-14");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, lastModified, changeFrequency: "monthly", priority: 1 },
    {
      url: `${siteUrl}/guides/recurring-email-gmail`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${siteUrl}/guides/gmail-recurring-email-extension-alternative`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
