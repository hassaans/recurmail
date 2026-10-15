import { expect } from "@playwright/test";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

// The server renders without the reader's locale or time zone. Any date the
// signed-in pages format in the browser's own locale differs from the server
// HTML for a reader outside en-US and makes React throw away the page.
test.use({ locale: "en-GB", timezoneId: "Asia/Karachi" });

test("signed-in pages hydrate without a mismatch in a non-US locale and time zone", async ({
  page,
  context,
  request,
  scenario,
}) => {
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
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (/hydrat/i.test(message.text())) problems.push(message.text());
  });

  await page.goto("/dashboard");
  await expect(
    page.getByText(`Signed in as ${scenario.connected.email}`),
  ).toBeVisible();
  const start = new Date(Date.now() + 3600000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const created = await page.evaluate(async (rrule) => {
    const response = await fetch("/api/schedules", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: "Weekly report",
        body_text: "A weekly reminder.",
        to: ["team@example.test"],
        rrule,
        timezone: "Asia/Karachi",
      }),
    });
    return {
      status: response.status,
      id: ((await response.json()) as { schedule: { id: string } }).schedule.id,
    };
  }, `DTSTART:${start}\nRRULE:FREQ=WEEKLY`);
  expect(created.status).toBe(201);

  for (const path of [
    "/dashboard",
    "/schedules/new",
    `/schedules/${created.id}`,
    `/schedules/${created.id}/edit`,
    "/settings",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    // Give React time to report a mismatch found while hydrating.
    await page.waitForTimeout(500);
    expect(problems, `${path} hydrated with errors`).toEqual([]);
  }
});
