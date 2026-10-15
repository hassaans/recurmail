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
    const desktop = width > 860;
    const signup = nav.getByRole("link", {
      name: desktop ? "Create free account" : "Sign up free",
      exact: true,
    });
    await expect(signup).toBeVisible();
    await expect(signup).toHaveAttribute("href", "/auth/signin");
    // On phones Log in is one tap away, in the menu.
    if (!desktop) await nav.getByRole("button", { name: "Menu" }).click();
    const login = nav.getByRole("link", { name: "Log in", exact: true });
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", "/dashboard");
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

const middle = (box: { y: number; height: number }) => box.y + box.height / 2;

test("on phones and tablets the header is one row: logo, sign-up button, menu button", async ({
  page,
}) => {
  for (const path of ["/", "/guides/recurring-email-gmail"]) {
    for (const width of [768, 430, 390, 375, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);

      const nav = page.getByRole("navigation", { name: "Main navigation" });
      const logo = nav.getByRole("link", { name: "RecurMail home" });
      const signup = nav.getByRole("link", {
        name: "Sign up free",
        exact: true,
      });
      const menu = nav.getByRole("button", { name: "Menu" });
      const boxes = await Promise.all(
        [logo, signup, menu].map((item) => item.boundingBox()),
      );
      if (boxes.some((box) => !box)) throw new Error("header must render");
      const [logoBox, signupBox, menuBox] = boxes as NonNullable<
        (typeof boxes)[number]
      >[];
      for (const box of [signupBox, menuBox])
        expect(Math.abs(middle(box) - middle(logoBox))).toBeLessThan(4);
      expect(signupBox.x).toBeGreaterThan(logoBox.x + logoBox.width);
      expect(menuBox.x).toBeGreaterThan(signupBox.x + signupBox.width);
      expect(menuBox.width).toBeGreaterThanOrEqual(44);
      expect(menuBox.height).toBeGreaterThanOrEqual(44);
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      // Section links and Log in wait in the closed menu.
      for (const name of ["How it works", "FAQ", "Log in"])
        await expect(nav.getByRole("link", { name, exact: true })).toBeHidden();
      await expect(signup).toHaveCSS("text-decoration-line", "none");
      await expect(signup).toHaveCSS("white-space", "nowrap");
      const header = await page.getByRole("banner").boundingBox();
      expect(header?.height).toBeLessThan(100);
      // Tab follows the row: logo, sign-up, menu.
      await logo.focus();
      await page.keyboard.press("Tab");
      await expect(signup).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu).toBeFocused();

      const pageWidths = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(pageWidths.document).toBeLessThanOrEqual(pageWidths.viewport);
    }
  }
});

test("the phone menu opens, lists the links, and closes on Escape, outside taps and link taps", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/guides/recurring-email-gmail");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const menu = nav.getByRole("button", { name: "Menu" });
  const panel = page.locator(`#${await menu.getAttribute("aria-controls")}`);

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  const links = panel.getByRole("link");
  await expect(links).toHaveText([
    "How it works",
    "FAQ",
    "Extension alternative",
    "Log in",
  ]);
  const hrefs = await links.evaluateAll((items) =>
    items.map((item) => item.getAttribute("href")),
  );
  expect(hrefs).toEqual([
    "/#how-it-works",
    "/#faq",
    "/guides/gmail-recurring-email-extension-alternative",
    "/dashboard",
  ]);
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  // The panel follows the button, so Tab moves into the open menu.
  await menu.focus();
  await page.keyboard.press("Tab");
  await expect(links.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();

  await menu.click();
  await expect(panel).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(panel).toBeHidden();

  await page.goto("/");
  const homePanel = page.locator(
    `#${await menu.getAttribute("aria-controls")}`,
  );
  await menu.click();
  await homePanel.getByRole("link", { name: "FAQ", exact: true }).click();
  await expect(homePanel).toBeHidden();
  await expect(page).toHaveURL(/#faq$/);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(menu).toBeHidden();
});

test("legal and missing pages keep Log in in the row, with no one-item menu", async ({
  page,
}) => {
  for (const path of ["/terms", "/privacy", "/no-such-page"]) {
    for (const width of [390, 360, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      await expect(nav.getByRole("button", { name: "Menu" })).toHaveCount(0);
      const row = [
        nav.getByRole("link", { name: "RecurMail home" }),
        nav.getByRole("link", { name: "Log in", exact: true }),
        nav.getByRole("link", { name: "Sign up free", exact: true }),
      ];
      const boxes = await Promise.all(row.map((item) => item.boundingBox()));
      if (boxes.some((box) => !box)) throw new Error("header must render");
      const [logoBox, loginBox, signupBox] = boxes as NonNullable<
        (typeof boxes)[number]
      >[];
      for (const box of [loginBox, signupBox])
        expect(Math.abs(middle(box) - middle(logoBox))).toBeLessThan(4);
      expect(loginBox.x).toBeGreaterThan(logoBox.x + logoBox.width);
      expect(signupBox.x).toBeGreaterThan(loginBox.x + loginBox.width);
      const pageWidths = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(pageWidths.document).toBeLessThanOrEqual(pageWidths.viewport);
    }
  }
});

test("on desktop the header is one row with the sign-up button last, at its original size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const path of ["/", "/guides/recurring-email-gmail", "/terms"]) {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    const signup = nav.getByRole("link", {
      name: "Create free account",
      exact: true,
    });
    const login = nav.getByRole("link", { name: "Log in", exact: true });
    await expect(signup).toHaveCSS("font-size", "15px");
    await expect(signup).toHaveCSS("text-decoration-line", "none");
    const signupBox = await signup.boundingBox();
    const loginBox = await login.boundingBox();
    if (!signupBox || !loginBox) throw new Error("header links must render");
    expect(signupBox.x).toBeGreaterThan(loginBox.x + loginBox.width);
    expect(
      Math.abs(
        signupBox.y + signupBox.height / 2 - (loginBox.y + loginBox.height / 2),
      ),
    ).toBeLessThan(4);
    await expect(nav.getByRole("button", { name: "Menu" })).toBeHidden();
    await login.focus();
    await page.keyboard.press("Tab");
    await expect(signup).toBeFocused();
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

test("homepage is not marked up as a story, so Safari does not offer Reader", async ({
  page,
}) => {
  await page.goto("/");
  // Safari offers (or auto-opens) Reader for article-like pages. Its detector
  // keys on <p> text, so homepage copy uses styled divs instead; the
  // "Safari Reader" workflow runs Safari's own detection as the real check.
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.locator("main p")).toHaveCount(0);
  await expect(page.locator("ul.cal-grid > li")).toHaveCount(6);
  await expect(page.locator("ul.ways > li")).toHaveCount(2);
  const markers = await page
    .locator("ul.cal-grid, ul.ways")
    .evaluateAll((lists) =>
      lists.map((l) => getComputedStyle(l).listStyleType),
    );
  expect(markers).toEqual(["none", "none"]);
});
