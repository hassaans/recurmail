import { expect, type Page } from "@playwright/test";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

// Layout checks for the signed-in app: one shared shell on every route, no
// horizontal overflow at 375px, schedule times in the schedule's own zone,
// and a working sign-out.

async function createSchedule(page: Page, input: object) {
  return page.evaluate(async (data) => {
    const response = await fetch("/api/schedules", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return {
      status: response.status,
      body: (await response.json()) as { schedule: ScheduleRow },
    };
  }, input);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
}

async function expectShell(
  page: Page,
  email: string,
  active: "Schedules" | "Settings",
) {
  const banner = page.getByRole("banner");
  const logo = banner.getByRole("link", { name: "RecurMail home" });
  await expect(logo).toHaveAttribute("href", "/dashboard");
  const nav = banner.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Schedules" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
    "href",
    "/settings",
  );
  await expect(nav.getByRole("link", { name: active })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    nav.getByRole("link", {
      name: active === "Schedules" ? "Settings" : "Schedules",
    }),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(banner.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Privacy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
  await expect(footer.getByRole("link", { name: "Terms" })).toHaveAttribute(
    "href",
    "/terms",
  );
  await expect(footer).toContainText("Gmail is a trademark of Google LLC.");
  // Exactly one shell: no page renders a second header or footer of its own.
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
}

test.beforeEach(async ({ page, context, request, scenario }) => {
  const setup = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/schedule-api`,
  );
  expect(setup.status()).toBe(200);
  await context.addCookies([
    testSessionCookie(
      scenario.connected.accessToken,
      undefined,
      scenario.connected.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  await expect(
    page.getByText(`Signed in as ${scenario.connected.email}`),
  ).toBeVisible();
});

test("every signed-in route renders the shared shell with logo, navigation and sign out", async ({
  page,
  scenario,
}) => {
  const created = await createSchedule(page, {
    subject: "Shell check",
    body_text: "Shell message",
    to: ["shell@example.test"],
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    timezone: "UTC",
  });
  expect(created.status).toBe(201);
  const id = created.body.schedule.id;
  for (const route of [
    "/dashboard",
    "/schedules/new",
    `/schedules/${id}`,
    `/schedules/${id}/edit`,
  ]) {
    await page.goto(route);
    await expectShell(page, scenario.connected.email, "Schedules");
  }
  await page.goto("/settings");
  await expectShell(page, scenario.connected.email, "Settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
});

test("dashboard, history and settings fit a 375px viewport without horizontal overflow", async ({
  page,
}) => {
  // 63-character local part (the limit is 64) plus a long domain so the
  // address is wider than a phone screen.
  const longAddress = `a-very-long-recipient-address-that-should-wrap-${"x".repeat(16)}@a-long-subdomain.another-long-subdomain.example.test`;
  const created = await createSchedule(page, {
    subject:
      "A long subject line that keeps going so the card has to wrap it on a phone",
    body_text: "Mobile message",
    to: [longAddress, "two@example.test"],
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=30;BYSECOND=0",
    timezone: "America/New_York",
  });
  expect(created.status).toBe(201);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const route of [
    "/dashboard",
    `/schedules/${created.body.schedule.id}`,
    "/settings",
  ]) {
    await page.goto(route);
    await expect(page.getByRole("banner")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  // Collapsed header: logo and Sign out share the top row, the navigation
  // drops to its own full-width row underneath, and the email wraps below.
  const banner = page.getByRole("banner");
  const logo = await banner
    .getByRole("link", { name: "RecurMail home" })
    .boundingBox();
  const signOut = await banner
    .getByRole("button", { name: "Sign out" })
    .boundingBox();
  const nav = await banner
    .getByRole("navigation", { name: "Main navigation" })
    .boundingBox();
  const email = await banner.getByText("Signed in as").boundingBox();
  if (!logo || !signOut || !nav || !email) throw new Error("header missing");
  expect(
    Math.abs(signOut.y + signOut.height / 2 - (logo.y + logo.height / 2)),
  ).toBeLessThan(logo.height);
  expect(signOut.x).toBeGreaterThan(logo.x + logo.width);
  expect(nav.y).toBeGreaterThanOrEqual(logo.y + logo.height);
  expect(nav.width).toBeGreaterThan(300);
  expect(email.y).toBeGreaterThanOrEqual(nav.y + nav.height);
  expect(email.x + email.width).toBeLessThanOrEqual(375);
});

test("a Karachi schedule shows 6:25 AM in its own timezone on the dashboard and history", async ({
  page,
}) => {
  const created = await createSchedule(page, {
    subject: "Karachi standup",
    body_text: "Standup message",
    to: ["team@example.test"],
    rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=25;BYSECOND=0",
    timezone: "Asia/Karachi",
  });
  expect(created.status).toBe(201);
  await page.goto("/dashboard");
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Karachi standup" });
  await expect(card).toContainText("Every day at 6:25 AM");
  await expect(card).toContainText(/Next send.*at 6:25 AM PKT/);
  await page.goto(`/schedules/${created.body.schedule.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Karachi standup",
  );
  await expect(page.getByText("Every day at 6:25 AM PKT")).toBeVisible();
  await expect(page.getByText(/at 6:25 AM PKT$/).first()).toBeVisible();
});

test("sign out clears the session from the shell and the dashboard asks to sign in again", async ({
  page,
  context,
}) => {
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  const cookies = await context.cookies();
  expect(
    cookies.find((cookie) => cookie.name === "rm_session"),
  ).toBeUndefined();
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sign in to RecurMail",
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("sign-out rejects GET and cross-origin posts without clearing the session", async ({
  page,
  request,
  scenario,
}) => {
  const forbidden = await request.post("/auth/signout", {
    headers: { Origin: "https://attacker.test" },
    maxRedirects: 0,
  });
  expect(forbidden.status()).toBe(403);
  expect(forbidden.headers()["set-cookie"]).toBeUndefined();
  const wrongMethod = await request.get("/auth/signout", { maxRedirects: 0 });
  expect(wrongMethod.status()).toBe(405);
  await page.reload();
  await expect(
    page.getByText(`Signed in as ${scenario.connected.email}`),
  ).toBeVisible();
});

test("keyboard users reach a skip link first and can tab into the main navigation", async ({
  page,
}) => {
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "RecurMail home" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", {
        name: "Schedules",
      }),
  ).toBeFocused();
});
