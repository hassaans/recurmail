import { expect, type Page } from "@playwright/test";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

interface ForecastResponse {
  schedule: ScheduleRow;
  dailyLimitCheck: {
    status: "ok" | "warn" | "over";
    count: number;
    limit: number;
  };
  warning?: string;
}

// Browser fetch supplies the real Origin and HttpOnly session cookie. The app's
// authentication, route handlers and Supabase store all run without interception.
async function browserRequest<T>(
  page: Page,
  path: string,
  method = "GET",
  data?: object,
) {
  return page.evaluate(
    async ({ path, method, data }) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        ...(data === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            }),
      });
      return {
        status: response.status,
        body: (response.status === 204 ? null : await response.json()) as T,
      };
    },
    { path, method, data },
  );
}

function dailyInput(recipientCount = 400) {
  const recipients = Array.from(
    { length: recipientCount },
    (_, index) => `recipient${index}@example.test`,
  );
  // Start in one hour, independently of the host clock's time of day. Daily UTC
  // occurrences are exactly 24 hours apart, so each rolling window counts one send.
  const start = new Date(Date.now() + 3600000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return {
    subject: "Daily recipient forecast",
    body_text: "A daily reminder.",
    to: recipients.slice(0, 200),
    cc: recipients.slice(200, 300),
    bcc: recipients.slice(300),
    rrule: `DTSTART:${start}\nRRULE:FREQ=DAILY`,
    timezone: "UTC",
  };
}

test.beforeEach(async ({ page, context, request, scenario }) => {
  const setup = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/schedule-api`,
  );
  expect(setup.status()).toBe(200);
  expect(await setup.json()).toEqual({ user_id: scenario.connected.id });
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
  await expect(
    page.getByRole("heading", { name: "Gmail is connected", exact: true }),
  ).toBeVisible();
  const listed = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(listed.status).toBe(200);
  expect(listed.body.schedules).toEqual([]);
});

test("creates a weekly schedule with a future send, then reads, edits and deletes its owned row", async ({
  page,
  scenario,
}) => {
  const input = {
    subject: "Weekly reminder",
    body_text: "The weekly update.",
    to: ["weekly@example.test"],
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    timezone: "UTC",
  };
  const before = Date.now();
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    input,
  );
  expect(created.status).toBe(201);
  const schedule = created.body.schedule;
  expect(schedule).toMatchObject({
    ...input,
    user_id: scenario.connected.id,
    status: "active",
    body_html: null,
    cc: [],
    bcc: [],
    source: "web",
  });
  expect(schedule.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(Date.parse(schedule.next_send_at)).toBeGreaterThan(before);
  expect(Date.parse(schedule.next_send_at)).toBeGreaterThan(
    Date.parse(schedule.created_at),
  );
  expect(new Date(schedule.next_send_at).getUTCDay()).toBe(1);
  expect(new Date(schedule.next_send_at).getUTCHours()).toBe(9);
  expect(schedule.updated_at).toBe(schedule.created_at);

  const path = `/api/schedules/${schedule.id}`;
  const read = await browserRequest<{ schedule: ScheduleRow }>(page, path);
  expect(read.status).toBe(200);
  expect(read.body.schedule).toEqual(schedule);
  const listed = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(listed.status).toBe(200);
  expect(listed.body.schedules).toEqual([schedule]);

  const edited = await browserRequest<ForecastResponse>(page, path, "PATCH", {
    subject: "Updated weekly reminder",
  });
  expect(edited.status).toBe(200);
  expect(edited.body.schedule).toMatchObject({
    ...schedule,
    subject: "Updated weekly reminder",
    updated_at: expect.any(String),
  });
  const reread = await browserRequest<{ schedule: ScheduleRow }>(page, path);
  expect(reread.status).toBe(200);
  expect(reread.body.schedule).toEqual(edited.body.schedule);

  const deleted = await browserRequest<null>(page, path, "DELETE");
  expect(deleted).toEqual({ status: 204, body: null });
  expect((await browserRequest(page, path)).status).toBe(404);
  const remaining = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(remaining.status).toBe(200);
  expect(remaining.body.schedules).toEqual([]);
});

test("weekly Monday editor saves and dashboard shows the next Monday", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "To" }).fill("weekly@example.test");
  await page.getByLabel("Subject").fill("Monday check-in");
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("The weekly update.");
  await page.getByRole("combobox", { name: "Repeat" }).selectOption("weekly");
  await page.getByRole("checkbox", { name: "Monday" }).check();
  await page.getByRole("textbox", { name: "Time", exact: true }).fill("09:15");
  await expect(page.getByTestId("next-send-preview")).toContainText("Monday");
  await expect(
    page.getByTestId("next-send-preview").getByRole("listitem"),
  ).toHaveCount(5);
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  await expect(page.getByText("Monday check-in")).toBeVisible();
  const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(saved.body.schedules).toHaveLength(1);
  const nextMonday = new Date(saved.body.schedules[0].next_send_at);
  expect(nextMonday.getUTCDay()).toBe(1);
  await expect(page.getByText(/Next send:.*Monday/i)).toBeVisible();
});

test("schedule editor fits a 375px viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedules/new");
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
});

test("editor displays the daily-limit warning exactly as returned by the API", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  const recipients = Array.from(
    { length: 400 },
    (_, index) => `daily${index}@example.test`,
  );
  await page.getByRole("textbox", { name: "To" }).fill(recipients.join(", "));
  await page.getByLabel("Subject").fill("Daily limit warning");
  await page.getByRole("textbox", { name: "Message" }).fill("Daily message");
  await page.getByRole("combobox", { name: "Repeat" }).selectOption("daily");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  await expect(
    page.getByText(
      "Personal Gmail daily recipient limit forecast is warn (400/500).",
      { exact: true },
    ),
  ).toBeVisible();
});

test("edit mode loads and saves an existing schedule", async ({ page }) => {
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    {
      subject: "Existing title",
      body_text: "Existing message",
      to: ["existing@example.test"],
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "UTC",
    },
  );
  await page.goto(`/schedules/${created.body.schedule.id}/edit`);
  await expect(page.getByLabel("Subject")).toHaveValue("Existing title");
  await expect(page.getByRole("textbox", { name: "To" })).toHaveValue(
    "existing@example.test",
  );
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText(
    "Existing message",
  );
  await page.getByLabel("Subject").fill("Edited title");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const reread = await browserRequest<{ schedule: ScheduleRow }>(
    page,
    `/api/schedules/${created.body.schedule.id}`,
  );
  expect(reread.body.schedule.subject).toBe("Edited title");
});

test("400 distinct daily recipients produce a personal Gmail limit warning", async ({
  page,
  scenario,
}) => {
  const input = dailyInput();
  expect(new Set([...input.to, ...input.cc, ...input.bcc]).size).toBe(400);
  expect(scenario.connected.email).toMatch(/@gmail\.com$/);
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    input,
  );
  expect(created.status).toBe(201);
  expect(created.body.schedule).toMatchObject({
    ...input,
    user_id: scenario.connected.id,
    status: "active",
  });
  expect(created.body.dailyLimitCheck).toMatchObject({
    status: "warn",
    count: 400,
    limit: 500,
  });
  expect(created.body.warning).toBe(
    "Personal Gmail daily recipient limit forecast is warn (400/500).",
  );
});

test("pausing persists across reads and excludes the schedule from active results and forecasts", async ({
  page,
  request,
  scenario,
}) => {
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    dailyInput(),
  );
  expect(created.status).toBe(201);
  expect(created.body.schedule.status).toBe("active");
  expect(created.body.dailyLimitCheck).toMatchObject({
    count: 400,
    status: "warn",
  });
  const path = `/api/schedules/${created.body.schedule.id}`;
  const activeRows = async () => {
    const response = await request.get(`${fakeSupabaseUrl}/rest/v1/schedules`, {
      headers: {
        apikey: "fake-anon-key",
        Authorization: `Bearer ${scenario.connected.accessToken}`,
      },
      params: {
        user_id: `eq.${scenario.connected.id}`,
        status: "eq.active",
        select: "id,status",
      },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  expect(await activeRows()).toEqual([
    { id: created.body.schedule.id, status: "active" },
  ]);
  const paused = await browserRequest<{ schedule: ScheduleRow }>(
    page,
    `${path}/pause`,
    "POST",
  );
  expect(paused.status).toBe(200);
  expect(paused.body.schedule).toMatchObject({
    ...created.body.schedule,
    status: "paused",
    updated_at: expect.any(String),
  });

  // US-006 introduces the sender. US-005 can prove persisted paused status and
  // exclusion from active queries/recipient forecasts; it cannot prove that a
  // sender refrains from delivery. The API list intentionally includes all states.
  await page.reload();
  const read = await browserRequest<{ schedule: ScheduleRow }>(page, path);
  expect(read.status).toBe(200);
  expect(read.body.schedule).toEqual(paused.body.schedule);
  const listed = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(listed.status).toBe(200);
  expect(listed.body.schedules).toEqual([paused.body.schedule]);
  expect(
    listed.body.schedules.filter((row) => row.status === "active"),
  ).toEqual([]);
  expect(await activeRows()).toEqual([]);

  // PATCH forecasts zero recipient deliveries for the saved paused row.
  const edited = await browserRequest<ForecastResponse>(page, path, "PATCH", {
    subject: "Paused reminder",
  });
  expect(edited.status).toBe(200);
  expect(edited.body.schedule.status).toBe("paused");
  expect(edited.body.dailyLimitCheck).toMatchObject({
    status: "ok",
    count: 0,
    limit: 500,
  });
  expect(edited.body.warning).toBeUndefined();
  const probe = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    dailyInput(1),
  );
  expect(probe.status).toBe(201);
  expect(probe.body.dailyLimitCheck).toMatchObject({
    status: "ok",
    count: 1,
    limit: 500,
  });
  expect(probe.body.warning).toBeUndefined();
});
