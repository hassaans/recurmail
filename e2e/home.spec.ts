import { expect, test } from "@playwright/test";

const siteUrl = "https://recurmail.com";

test("visitor can load the RecurMail homepage with its SEO data", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(
    "Send recurring emails from Gmail for free | RecurMail",
  );
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Send recurring emails from your own Gmail.",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    siteUrl,
  );
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Write an email once and choose a schedule. RecurMail sends it from your Gmail account each time, with a record in Sent. Free to use.",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `${siteUrl}/opengraph-image`,
  );

  const jsonLdText = await page
    .locator('script[type="application/ld+json"]')
    .textContent();
  expect(jsonLdText).toBeTruthy();
  const jsonLd = JSON.parse(jsonLdText ?? "null") as {
    "@graph": Array<{ "@type": string }>;
  };
  expect(jsonLd["@graph"].map((entry) => entry["@type"])).toEqual(
    expect.arrayContaining(["WebSite", "SoftwareApplication", "FAQPage"]),
  );

  await expect(
    page.getByText("Gmail is a trademark of Google LLC."),
  ).toBeVisible();
});

test("homepage nav keeps sign-in calls to action visible on desktop and mobile", async ({
  page,
}) => {
  for (const width of [1280, 375, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");

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
    await expect(page.getByText("Launching soon", { exact: true })).toHaveCount(
      0,
    );
    const pageWidths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(pageWidths.document).toBeLessThanOrEqual(pageWidths.viewport);
  }
});

test("dashboard logo uses the brand font and keeps space between mark and wordmark", async ({
  page,
}) => {
  const externalFontRequests: string[] = [];
  const localFontResponses: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "fonts.googleapis.com") {
      externalFontRequests.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (
      response.url().includes("/_next/static/media/") &&
      response.url().endsWith(".woff2")
    ) {
      localFontResponses.push(response.url());
    }
  });

  await page.goto("/dashboard");
  const logo = page.getByRole("link", { name: "RecurMail home" });
  await expect(logo).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const layout = await logo.evaluate((element) => {
    const mark = element.querySelector("svg");
    const wordmark = Array.from(element.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    if (!mark || !wordmark) throw new Error("Dashboard logo parts are missing");
    const markBox = mark.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(wordmark);
    const wordmarkBox = range.getBoundingClientRect();
    return {
      fontFamily: getComputedStyle(element).fontFamily,
      gap: wordmarkBox.left - markBox.right,
    };
  });

  expect(layout.fontFamily).toContain("Plus Jakarta Sans");
  expect(layout.gap).toBeGreaterThanOrEqual(8);
  expect(externalFontRequests).toEqual([]);
  expect(localFontResponses.length).toBeGreaterThanOrEqual(2);
});

test("crawler routes list the homepage and both guides", async ({
  request,
}) => {
  const sitemapResponse = await request.get("/sitemap.xml");
  expect(sitemapResponse.status()).toBe(200);
  const sitemap = await sitemapResponse.text();
  expect(sitemap).toContain(`<loc>${siteUrl}</loc>`);
  expect(sitemap).toContain(
    `<loc>${siteUrl}/guides/recurring-email-gmail</loc>`,
  );
  expect(sitemap).toContain(
    `<loc>${siteUrl}/guides/gmail-recurring-email-extension-alternative</loc>`,
  );

  const robotsResponse = await request.get("/robots.txt");
  expect(robotsResponse.status()).toBe(200);
  expect(await robotsResponse.text()).toContain(`${siteUrl}/sitemap.xml`);
});

test("guide routes render useful content and page metadata", async ({
  page,
}) => {
  const guides = [
    {
      path: "/guides/recurring-email-gmail",
      heading: "How to send recurring email in Gmail",
      title: "How to Send Recurring Email in Gmail | RecurMail",
      canonical: `${siteUrl}/guides/recurring-email-gmail`,
      bodyText:
        "Gmail's Schedule send lets you choose a future date and time for one message.",
    },
    {
      path: "/guides/gmail-recurring-email-extension-alternative",
      heading: "A free alternative to Gmail recurring email extensions",
      title: "Free Gmail Recurring Email Extension Alternative | RecurMail",
      canonical: `${siteUrl}/guides/gmail-recurring-email-extension-alternative`,
      bodyText:
        "Check where schedules are stored, whether your computer must stay open",
    },
  ];

  for (const guide of guides) {
    const response = await page.goto(guide.path);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      guide.heading,
    );
    await expect(page).toHaveTitle(guide.title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /.+/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      guide.canonical,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      `${siteUrl}/opengraph-image`,
    );
    await expect(
      page.getByText(guide.bodyText, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Gmail is a trademark of Google LLC."),
    ).toBeVisible();
  }
});

test("homepage and guides fit a narrow screen and keep the skip link available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const paths = [
    "/",
    "/guides/recurring-email-gmail",
    "/guides/gmail-recurring-email-extension-alternative",
  ];

  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const widths = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  }

  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
});

test("Open Graph image route serves a PNG", async ({ request }) => {
  const response = await request.get("/opengraph-image");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  expect((await response.body()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
});
