import { expect } from "@playwright/test";
import { test } from "./fixtures/auth";

test("privacy policy describes Gmail data, deletion and service providers", async ({
  page,
}) => {
  await page.goto("/privacy");
  await expect(
    page.getByRole("heading", { name: "Privacy Policy" }),
  ).toBeVisible();
  for (const text of [
    "https://www.googleapis.com/auth/gmail.send",
    "Google API Services User Data Policy",
    "Limited Use",
    "encrypted",
    "retention settings",
    "Sentry",
    "Resend",
    "Supabase",
    "Vercel",
    "Owner placeholder. Add the legal entity name and mailing address.",
  ])
    await expect(page.locator("body")).toContainText(text);
  await expect(
    page.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/terms");
});

test("legal pages are linked from the homepage, guides and app footer", async ({
  page,
}) => {
  for (const route of [
    "/",
    "/guides/recurring-email-gmail",
    "/guides/gmail-recurring-email-extension-alternative",
    "/dashboard",
  ]) {
    await page.goto(route);
    await expect(
      page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }),
    ).toHaveAttribute("href", "/privacy");
    await expect(
      page.getByRole("contentinfo").getByRole("link", { name: "Terms" }),
    ).toHaveAttribute("href", "/terms");
  }
  await page.goto("/terms");
  await expect(
    page.getByRole("heading", { name: "Terms of Service" }),
  ).toBeVisible();
});
