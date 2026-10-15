import { expect, type Page } from "@playwright/test";
import { scheduleDefaults } from "../apps/web/lib/schedule-editor";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

async function pickTimeZone(page: Page, query: string, optionName: RegExp) {
  const picker = page.getByRole("combobox", { name: "Time zone" });
  await picker.fill(query);
  await page.getByRole("option", { name: optionName }).click();
}

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
  await page.getByRole("radio", { name: "Weekly" }).check();
  for (const day of WEEKDAY_NAMES) {
    await page
      .getByRole("checkbox", { name: day })
      .setChecked(day === "Monday");
  }
  await page.getByLabel("Time", { exact: true }).fill("09:15");
  await pickTimeZone(page, "UTC", /Coordinated Universal Time/);
  await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    "Coordinated Universal Time (UTC), UTC+0",
  );
  await expect(page.getByTestId("schedule-summary")).toContainText(
    "Every Monday at 9:15 AM, Coordinated Universal Time",
  );
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
  await expect(page.getByText(/Next send.*Monday/i)).toBeVisible();
});

test("schedule editor fits a 375px viewport without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/schedules/new");
  await page
    .getByRole("textbox", { name: "To" })
    .fill("first@example.test, second@example.test, third@example.test ");
  await page.getByRole("button", { name: "Add Cc" }).click();
  await expect(page.getByRole("textbox", { name: "Cc" })).toBeFocused();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  const dayRows = new Set<number>();
  for (const day of WEEKDAY_NAMES) {
    const box = await page.getByRole("checkbox", { name: day }).boundingBox();
    expect(box).not.toBeNull();
    dayRows.add(Math.round(box?.y ?? -1));
  }
  expect(dayRows.size).toBe(1);
  const actions = page.getByRole("button", { name: "Save schedule" });
  await expect(actions).toBeInViewport();
  await expect(page.getByRole("link", { name: "Cancel" })).toBeInViewport();
});

test.describe("browser time zone", () => {
  test.use({ timezoneId: "Asia/Karachi" });

  test("new schedules default to the browser zone, today's weekday and the next whole hour", async ({
    page,
  }) => {
    const before = scheduleDefaults(new Date(), "Asia/Karachi");
    await page.goto("/schedules/new");
    await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue(
      "Pakistan Time (Asia/Karachi), UTC+5",
    );
    await expect(page.getByRole("radio", { name: "Weekly" })).toBeChecked();
    const after = scheduleDefaults(new Date(), "Asia/Karachi");
    const timeValue = await page
      .getByLabel("Time", { exact: true })
      .inputValue();
    expect([before.time, after.time]).toContain(timeValue);
    const checked = await Promise.all(
      WEEKDAY_NAMES.map((day) =>
        page.getByRole("checkbox", { name: day }).isChecked(),
      ),
    );
    const checkedNames = WEEKDAY_NAMES.filter((_, index) => checked[index]);
    const expectedWeekday = timeValue === before.time ? before : after;
    const weekdayNameByKey: Record<string, string> = {
      MO: "Monday",
      TU: "Tuesday",
      WE: "Wednesday",
      TH: "Thursday",
      FR: "Friday",
      SA: "Saturday",
      SU: "Sunday",
    };
    expect(checkedNames).toEqual([weekdayNameByKey[expectedWeekday.weekday]]);
    await expect(page.getByTestId("schedule-summary")).toContainText(
      "Pakistan Time",
    );
    await page.getByRole("textbox", { name: "To" }).fill("pk@example.test");
    await page.getByLabel("Subject").fill("Karachi default");
    await page.getByRole("textbox", { name: "Message" }).fill("Salaam");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page).toHaveURL(/\/dashboard\?saved=1/);
    const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
      page,
      "/api/schedules",
    );
    expect(saved.body.schedules).toHaveLength(1);
    expect(saved.body.schedules[0].timezone).toBe("Asia/Karachi");
    expect(saved.body.schedules[0].rrule).toContain(
      "BYDAY=" + expectedWeekday.weekday,
    );
    expect(saved.body.schedules[0].rrule).toContain(
      "BYHOUR=" + Number(expectedWeekday.time.slice(0, 2)),
    );
  });
});

test("recipient chips commit on comma and Enter, flag bad addresses and remove with Backspace", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  const to = page.getByRole("textbox", { name: "To" });
  const chips = page
    .getByRole("list", { name: "To recipients" })
    .getByRole("listitem");
  await to.pressSequentially("ayesha@example.test, omar@example.test");
  await expect(chips).toHaveText(["ayesha@example.test"]);
  await expect(to).toHaveValue("omar@example.test");
  await to.press("Enter");
  await expect(chips).toHaveText(["ayesha@example.test", "omar@example.test"]);
  await expect(to).toHaveValue("");
  await expect(page.getByText("2 recipients")).toBeVisible();
  await to.pressSequentially("not-an-address");
  await to.press("Enter");
  await expect(chips).toHaveText([
    "ayesha@example.test",
    "omar@example.test",
    "Invalid address: not-an-address",
  ]);
  await expect(
    page.getByText("One address doesn't look right. Fix or remove it."),
  ).toBeVisible();
  await to.press("Backspace");
  await expect(chips).toHaveText(["ayesha@example.test", "omar@example.test"]);
  await page
    .getByRole("button", { name: "Remove ayesha@example.test" })
    .click();
  await expect(chips).toHaveText(["omar@example.test"]);
  await expect(to).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Cc" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add Bcc" }).click();
  await expect(page.getByRole("textbox", { name: "Bcc" })).toBeFocused();
});

test("saving an empty form shows inline errors and focuses the first one", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  await expect(page.getByText("Add at least one recipient.")).toBeVisible();
  await expect(page.getByText("Add a subject.")).toBeVisible();
  await expect(page.getByText("Write a message.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "To" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "To" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.getByRole("textbox", { name: "To" }).fill("fixed@example.test ");
  await expect(page.getByText("Add at least one recipient.")).toHaveCount(0);
});

test("dashboard summarizes schedules and pause-all pauses every active schedule", async ({
  page,
}) => {
  const first = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    {
      subject: "First reminder",
      body_text: "First message",
      to: ["one@example.test", "two@example.test"],
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "UTC",
    },
  );
  const second = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    {
      subject: "Second reminder",
      body_text: "Second message",
      to: ["three@example.test"],
      rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "UTC",
    },
  );
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);

  await page.reload();
  await expect(page.getByText("First reminder")).toBeVisible();
  await expect(page.getByText("2 recipients")).toBeVisible();
  await expect(page.getByText("Every day")).toBeVisible();
  await expect(page.getByText("Every week on Monday and Friday")).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "Edit", exact: true }),
  ).toHaveCount(2);
  await page.setViewportSize({ width: 375, height: 812 });
  const dashboardDimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dashboardDimensions.document).toBeLessThanOrEqual(
    dashboardDimensions.viewport,
  );

  await page.getByRole("button", { name: "Pause all schedules" }).click();
  await expect(page.getByText("Paused", { exact: true })).toHaveCount(2);
  const firstRow = page
    .getByRole("listitem")
    .filter({ hasText: "First reminder" });
  const resumeButton = firstRow.getByRole("button", { name: "Resume" });
  await expect(resumeButton).toBeEnabled();
  await resumeButton.click();
  await expect(firstRow).toContainText("Status Active");
  const pauseButton = firstRow.getByRole("button", { name: "Pause" });
  await expect(pauseButton).toBeEnabled();
  await pauseButton.click();
  await expect(firstRow).toContainText("Status Paused");
  const secondRow = page
    .getByRole("listitem")
    .filter({ hasText: "Second reminder" });
  const deleteButton = secondRow.getByRole("button", { name: "Delete" });
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(secondRow).toHaveCount(0);
});

test("schedule history shows sent and failed entries with plain-language reasons", async ({
  page,
  request,
  scenario,
}) => {
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    {
      subject: "History reminder",
      body_text: "History message",
      to: ["history@example.test"],
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: "UTC",
    },
  );
  expect(created.status).toBe(201);
  const seeded = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/send-log`,
    {
      data: {
        schedule_id: created.body.schedule.id,
        rows: [
          {
            attempted_at: "2026-10-14T09:00:00.000Z",
            scheduled_for: "2026-10-14T09:00:00.000Z",
            status: "sent",
            error_code: null,
          },
          {
            attempted_at: "2026-10-15T09:00:00.000Z",
            scheduled_for: "2026-10-15T09:00:00.000Z",
            status: "failed",
            error_code: "invalid_grant",
          },
          {
            attempted_at: "2026-10-16T09:00:00.000Z",
            scheduled_for: "2026-10-16T09:00:00.000Z",
            status: "deferred",
            error_code: "gmail_quota_deferred",
          },
        ],
      },
    },
  );
  expect(seeded.status()).toBe(200);

  await page.goto(`/schedules/${created.body.schedule.id}`);
  await expect(
    page.getByRole("heading", { name: "Send history", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Deferred", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Gmail permission needs renewing/i),
  ).toBeVisible();
  await expect(page.getByText(/Gmail daily sending limit/i)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const historyDimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(historyDimensions.document).toBeLessThanOrEqual(
    historyDimensions.viewport,
  );
});

test("needs_reconnect shows a clear reconnect banner and action", async ({
  page,
  context,
  scenario,
}) => {
  await context.addCookies([
    testSessionCookie(
      scenario.reconnect.accessToken,
      undefined,
      scenario.reconnect.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  const reconnectBanner = page
    .getByRole("region", { name: "Gmail account" })
    .getByRole("alert");
  await expect(reconnectBanner).toContainText(/Gmail.*reconnect/i);
  await expect(
    reconnectBanner.getByRole("button", { name: /reconnect Gmail/i }),
  ).toBeVisible();
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
  await page.getByRole("radio", { name: "Daily" }).check();
  await expect(page.getByText("400 recipients")).toBeVisible();
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
  await expect(
    page.getByRole("list", { name: "To recipients" }).getByRole("listitem"),
  ).toHaveText(["existing@example.test"]);
  await expect(page.getByRole("textbox", { name: "Cc" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText(
    "Existing message",
  );
  await expect(page.getByRole("radio", { name: "Weekly" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Monday" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Tuesday" }),
  ).not.toBeChecked();
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("09:00");
  await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    "Coordinated Universal Time (UTC), UTC+0",
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
        apikey: "fake-publishable-key",
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
