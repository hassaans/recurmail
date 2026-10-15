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
    "RecurMail is run by Hassaan Saleem.",
  ])
    await expect(page.locator("body")).toContainText(text);
  await expect(page.locator("body")).not.toContainText("placeholder");
  await expect(
    page.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/terms");
});

test("legal pages use the shared brand header and edge-to-edge page background", async ({
  page,
}) => {
  for (const path of ["/privacy", "/terms"]) {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);

      const logo = page.getByRole("link", { name: "RecurMail home" });
      await expect(logo).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Open RecurMail" }),
      ).toHaveCount(0);
      await expect(page.locator("main .eyebrow")).toHaveCount(0);
      const fontFamily = await logo.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      expect(fontFamily).toContain("Plus Jakarta Sans");

      const bodyLayout = await page.evaluate(() => ({
        left: document.body.getBoundingClientRect().left,
        margin: getComputedStyle(document.body).margin,
      }));
      expect(bodyLayout.left).toBe(0);
      expect(bodyLayout.margin).toBe("0px");

      const nav = page.getByRole("navigation", { name: "Main navigation" });
      const login = nav.getByRole("link", { name: "Log in", exact: true });
      const signup = nav.getByRole("link", {
        name: "Create free account",
        exact: true,
      });
      await expect(login).toBeVisible();
      await expect(login).toHaveAttribute("href", "/dashboard");
      await expect(signup).toBeVisible();
      await expect(signup).toHaveAttribute("href", "/auth/signin");
      await expect(
        page
          .getByRole("contentinfo")
          .getByText(
            "Gmail is a trademark of Google LLC. RecurMail is not affiliated with Google.",
          ),
      ).toBeVisible();
      await expect(
        page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }),
      ).toHaveAttribute("href", "/privacy");
      await expect(
        page.getByRole("contentinfo").getByRole("link", { name: "Terms" }),
      ).toHaveAttribute("href", "/terms");
    }
  }
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

test("legal pages name the operator and the support, privacy and legal addresses, and every footer links to support", async ({
  page,
}) => {
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main).toContainText("RecurMail is run by Hassaan Saleem.");
    await expect(page.locator("body")).toContainText(
      "Last updated October 15, 2026",
    );
    await expect(main).not.toContainText("placeholder");
    await expect(
      main.getByRole("link", { name: "support@recurmail.com" }),
    ).toHaveAttribute("href", "mailto:support@recurmail.com");
    for (const address of ["privacy@recurmail.com", "legal@recurmail.com"])
      await expect(main.getByRole("link", { name: address })).toHaveAttribute(
        "href",
        `mailto:${address}`,
      );
    await expect(main).not.toContainText("hassaan@recurmail.com");
  }
  for (const route of [
    "/",
    "/guides/recurring-email-gmail",
    "/privacy",
    "/dashboard",
  ]) {
    await page.goto(route);
    await expect(
      page.getByRole("contentinfo").getByRole("link", { name: "Support" }),
    ).toHaveAttribute("href", "mailto:support@recurmail.com");
  }
});
