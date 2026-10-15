import { expect, test } from "@playwright/test";

// Basics every page needs: icons, a manifest, a branded 404 and security headers.

test("pages link a favicon, an Apple touch icon, a manifest and a theme colour, and each one is served", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const head = page.locator("head");
  const hrefs = {
    svg: await head
      .locator('link[rel="icon"][type="image/svg+xml"]')
      .getAttribute("href"),
    ico: await head
      .locator('link[rel="icon"][href*="favicon.ico"]')
      .getAttribute("href"),
    apple: await head
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href"),
    manifest: await head.locator('link[rel="manifest"]').getAttribute("href"),
  };
  await expect(head.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#6d3bef",
  );
  const types: Record<keyof typeof hrefs, RegExp> = {
    svg: /image\/svg\+xml/,
    ico: /image\/(x-icon|vnd\.microsoft\.icon)/,
    apple: /image\/png/,
    manifest: /application\/manifest\+json/,
  };
  for (const [name, href] of Object.entries(hrefs) as [
    keyof typeof hrefs,
    string | null,
  ][]) {
    expect(href, `${name} link`).toBeTruthy();
    const response = await request.get(href as string);
    expect(response.status(), `${name} status`).toBe(200);
    expect(response.headers()["content-type"], `${name} type`).toMatch(
      types[name],
    );
  }

  const manifest = await (await request.get(hrefs.manifest as string)).json();
  expect(manifest).toMatchObject({
    name: "RecurMail",
    start_url: "/dashboard",
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );
  expect(
    manifest.icons.some(
      (icon: { purpose?: string }) => icon.purpose === "maskable",
    ),
  ).toBe(true);
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  }
});

test("an unknown address shows a branded 404 with a way back, and is not indexed", async ({
  page,
}) => {
  const response = await page.goto("/no-such-page-here");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "We couldn't find that page",
  );
  await expect(page).toHaveTitle("Page not found | RecurMail");
  await expect(
    page.locator('meta[name="robots"][content*="noindex"]'),
  ).not.toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Go to the homepage" }),
  ).toHaveAttribute("href", "/");
  await expect(
    page.getByRole("link", { name: "Open your dashboard" }),
  ).toHaveAttribute("href", "/dashboard");
  await expect(
    page.getByRole("link", { name: "RecurMail home" }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
});

test("every page sends security headers that stop framing and sniffing", async ({
  request,
}) => {
  for (const path of ["/", "/dashboard", "/privacy", "/no-such-page-here"]) {
    const headers = (await request.get(path, { maxRedirects: 0 })).headers();
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["content-security-policy"], path).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers["permissions-policy"], path).toContain("camera=()");
  }
});
