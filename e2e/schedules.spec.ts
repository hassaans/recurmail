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
  await page.getByRole("option", { name: optionName }).first().click();
}

const DAY_KEYS: Record<string, string> = {
  Monday: "MO",
  Tuesday: "TU",
  Wednesday: "WE",
  Thursday: "TH",
  Friday: "FR",
  Saturday: "SA",
  Sunday: "SU",
};

/** The visible chip for a weekday; its checkbox is visually hidden. */
function dayChip(page: Page, day: string) {
  return page.getByTestId(`day-chip-${DAY_KEYS[day]}`);
}

/** Visible text of a Repeat segment; the radio behind it is visually hidden. */
function repeatSegment(page: Page, label: string) {
  return page.getByText(label, { exact: true });
}

/** A real pointer click at the centre of an element's box, like a user. */
/**
 * A real pointer click at the centre of the control, the way a user would do
 * it: scroll it to the middle of the viewport (clear of the sticky action bar
 * on small screens), then check that the control itself is the element under
 * the pointer before clicking. An overlay or a 1px input that swallows the
 * click fails here instead of silently hitting something else.
 */
async function clickCentre(page: Page, locator: ReturnType<Page["locator"]>) {
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("element has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await locator.evaluate(
    (element, point) => {
      const top = document.elementFromPoint(point.x, point.y);
      return top !== null && (top === element || element.contains(top));
    },
    { x, y },
  );
  expect(hit, `the control must be under the pointer at ${x},${y}`).toBe(true);
  await page.mouse.click(x, y);
}

async function setDay(page: Page, day: string, on: boolean) {
  const checkbox = page.getByRole("checkbox", { name: day });
  if ((await checkbox.isChecked()) !== on) await dayChip(page, day).click();
  await expect(checkbox).toBeChecked({ checked: on });
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
  await repeatSegment(page, "Weekly").click();
  await expect(page.getByRole("radio", { name: "Weekly" })).toBeChecked();
  for (const day of WEEKDAY_NAMES) await setDay(page, day, day === "Monday");
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
  await expect(
    page.getByRole("status").filter({ hasText: "Schedule saved." }),
  ).toBeVisible();
  await expect(page.getByText("Monday check-in")).toBeVisible();
  const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(saved.body.schedules).toHaveLength(1);
  const nextMonday = new Date(saved.body.schedules[0].next_send_at);
  expect(nextMonday.getUTCDay()).toBe(1);
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Monday check-in" });
  await expect(card).toContainText("Next send");
  await expect(card.locator("time")).toHaveText(/^Mon, .* at 9:15 AM /);
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
    const box = await dayChip(page, day).boundingBox();
    expect(box).not.toBeNull();
    dayRows.add(Math.round(box?.y ?? -1));
  }
  expect(dayRows.size).toBe(1);
  const actions = page.getByRole("button", { name: "Save schedule" });
  await expect(actions).toBeInViewport();
  await expect(page.getByRole("link", { name: "Cancel" })).toBeInViewport();

  // Every custom-builder shape must fit too: each unit, both monthly modes
  // and each "Ends" choice.
  const noOverflow = async (label: string) => {
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document, `${label} overflows 375px`).toBeLessThanOrEqual(
      widths.viewport,
    );
  };
  await repeatSegment(page, "Custom").click();
  await expect(page.getByTestId("custom-builder")).toBeVisible();
  for (const unit of ["days", "weeks", "months", "years"] as const) {
    await page.getByLabel("Repeat unit", { exact: true }).selectOption(unit);
    await noOverflow(`custom ${unit}`);
    if (unit === "months") {
      await page.locator("label[for='custom-month-mode-weekday']").click();
      await expect(page.locator("#custom-month-mode-weekday")).toBeChecked();
      await noOverflow("custom months on a weekday");
      await page.locator("label[for='custom-month-mode-day']").click();
    }
  }
  for (const ends of ["on", "after"] as const) {
    await page.getByLabel("Ends", { exact: true }).selectOption(ends);
    await expect(
      page.getByLabel(ends === "on" ? "End date" : "Number of sends", {
        exact: true,
      }),
    ).toBeVisible();
    await noOverflow(`ends ${ends}`);
  }

  // The opened time zone list stays inside the viewport.
  const picker = page.getByRole("combobox", { name: "Time zone" });
  await picker.click();
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  const listBox = await list.boundingBox();
  expect(listBox).not.toBeNull();
  expect(listBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((listBox?.x ?? 0) + (listBox?.width ?? 0)).toBeLessThanOrEqual(375);
  await noOverflow("open time zone list");
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

test.describe("browser with a legacy time zone id", () => {
  // Chromium still reports some zones under their old names. The picker shows
  // and saves the current IANA id instead.
  test.use({ timezoneId: "Asia/Calcutta" });

  test("new schedules default to the canonical id and saved legacy ids load as canonical", async ({
    page,
  }) => {
    await page.goto("/schedules/new");
    const picker = page.getByRole("combobox", { name: "Time zone" });
    await expect(picker).toHaveValue("India Time (Asia/Kolkata), UTC+5:30");
    await expect(page.getByTestId("schedule-summary")).toContainText(
      "India Time",
    );
    await expect(page.locator("main")).not.toContainText("Calcutta");
    await page.getByRole("textbox", { name: "To" }).fill("in@example.test");
    await page.getByLabel("Subject").fill("Kolkata default");
    await page.getByRole("textbox", { name: "Message" }).fill("Namaste");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page).toHaveURL(/\/dashboard\?saved=1/);
    const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
      page,
      "/api/schedules",
    );
    expect(saved.body.schedules).toHaveLength(1);
    expect(saved.body.schedules[0].timezone).toBe("Asia/Kolkata");

    // The saved notice has the success look and closes on its own.
    const notice = page
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: "Schedule saved." });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(notice).toHaveCount(0, { timeout: 10000 });

    // A schedule saved under the old id (the API still accepts it) opens and
    // saves under the current one.
    const legacy = await browserRequest<ForecastResponse>(
      page,
      "/api/schedules",
      "POST",
      {
        subject: "Saigon standup",
        body_text: "Legacy zone",
        to: ["vn@example.test"],
        rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "Asia/Saigon",
      },
    );
    expect(legacy.status).toBe(201);
    expect(legacy.body.schedule.timezone).toBe("Asia/Saigon");
    await page.goto(`/schedules/${legacy.body.schedule.id}/edit`);
    await expect(picker).toHaveValue(/\(Asia\/Ho_Chi_Minh\), UTC\+7$/);
    await expect(page.locator("main")).not.toContainText("Asia/Saigon");
    await page.getByLabel("Subject").fill("Ho Chi Minh City standup");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page).toHaveURL(/\/dashboard\?saved=1/);
    const reread = await browserRequest<{ schedule: ScheduleRow }>(
      page,
      `/api/schedules/${legacy.body.schedule.id}`,
    );
    expect(reread.body.schedule.timezone).toBe("Asia/Ho_Chi_Minh");
    expect(reread.body.schedule.subject).toBe("Ho Chi Minh City standup");
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
  await expect(
    page.getByText("one@example.test and two@example.test"),
  ).toBeVisible();
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
  const confirmPauseAll = page.getByRole("dialog", {
    name: "Pause all 2 schedules?",
  });
  await expect(confirmPauseAll).toContainText(
    "Nothing sends until you resume each one.",
  );
  await confirmPauseAll
    .getByRole("button", { name: "Pause all", exact: true })
    .click();
  await expect(confirmPauseAll).toHaveCount(0);
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
  const confirmDelete = page.getByRole("dialog", {
    name: "Delete this schedule?",
  });
  await expect(confirmDelete).toContainText("Second reminder");
  await confirmDelete.getByRole("button", { name: "Delete schedule" }).click();
  await expect(secondRow).toHaveCount(0);
  await expect(confirmDelete).toHaveCount(0);
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
  await repeatSegment(page, "Daily").click();
  await expect(page.getByRole("radio", { name: "Daily" })).toBeChecked();
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

/** Last Fridays at 17:00 UTC between now and `end`, capped at the 5 preview rows. */
function lastFridaysUntil(end: Date): number {
  const now = new Date();
  let count = 0;
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor <= end) {
    const lastDay = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 17),
    );
    const back = (lastDay.getUTCDay() - 5 + 7) % 7;
    const lastFriday = new Date(lastDay.getTime() - back * 86400000);
    if (lastFriday > now && lastFriday <= end) count += 1;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return Math.min(5, count);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "375px", width: 375, height: 812 },
]) {
  test(`every custom control in the editor responds to a real pointer click (${viewport.name})`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/schedules/new");
    // Repeat segments: a mouse click at the centre of the visible text.
    for (const label of ["Monthly", "Daily", "Custom", "Weekly"]) {
      await clickCentre(page, repeatSegment(page, label));
      await expect(page.getByRole("radio", { name: label })).toBeChecked();
    }
    // Day chips toggle on and off.
    for (const day of WEEKDAY_NAMES) {
      const checkbox = page.getByRole("checkbox", { name: day });
      const before = await checkbox.isChecked();
      await clickCentre(page, dayChip(page, day));
      await expect(checkbox).toBeChecked({ checked: !before });
      await clickCentre(page, dayChip(page, day));
      await expect(checkbox).toBeChecked({ checked: before });
    }
    await clickCentre(page, page.getByRole("button", { name: "Weekdays" }));
    await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Saturday" }),
    ).not.toBeChecked();
    await clickCentre(page, page.getByRole("button", { name: "Every day" }));
    await expect(
      page.getByRole("checkbox", { name: "Saturday" }),
    ).toBeChecked();
    // Add Cc / Add Bcc reveal and focus their fields.
    await clickCentre(page, page.getByRole("button", { name: "Add Cc" }));
    await expect(page.getByRole("textbox", { name: "Cc" })).toBeFocused();
    await clickCentre(page, page.getByRole("button", { name: "Add Bcc" }));
    await expect(page.getByRole("textbox", { name: "Bcc" })).toBeFocused();
    // Toolbar buttons format the selected text.
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill("Bold me");
    await message.press("ControlOrMeta+a");
    await clickCentre(page, page.getByRole("button", { name: "Bold" }));
    await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await message.innerHTML()).toMatch(/<(b|strong)>/);
    await clickCentre(page, page.getByRole("button", { name: "Italic" }));
    await expect(page.getByRole("button", { name: "Italic" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await clickCentre(
      page,
      page.getByRole("button", { name: "Bulleted list" }),
    );
    await expect(
      page.getByRole("button", { name: "Bulleted list" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await message.innerHTML()).toMatch(/<ul>/);
    // Keyboard still works too.
    await page.getByRole("radio", { name: "Weekly" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Monthly" })).toBeChecked();
  });
}

test("custom builder: every 2 weeks on two days, ending after a number of sends, round-trips through edit", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "To" }).fill("custom@example.test");
  await page.getByLabel("Subject").fill("Fortnightly digest");
  await page.getByRole("textbox", { name: "Message" }).fill("Digest body");
  await repeatSegment(page, "Custom").click();
  await expect(page.getByRole("radio", { name: "Custom" })).toBeChecked();
  const builder = page.getByTestId("custom-builder");
  await expect(builder).toBeVisible();
  await page.getByLabel("Repeat every", { exact: true }).fill("2");
  await page.getByLabel("Repeat unit", { exact: true }).selectOption("weeks");
  for (const day of WEEKDAY_NAMES)
    await setDay(page, day, day === "Monday" || day === "Friday");
  await page.getByLabel("Ends", { exact: true }).selectOption("after");
  await page.getByLabel("Number of sends", { exact: true }).fill("5");
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await pickTimeZone(page, "UTC", /Coordinated Universal Time/);
  await expect(page.getByTestId("schedule-summary")).toContainText(
    "Every 2 weeks on Monday and Friday at 9:30 AM, Coordinated Universal Time, for 5 sends",
  );
  await expect(
    page.getByTestId("next-send-preview").getByRole("listitem"),
  ).toHaveCount(5);
  // The rule syntax never reaches the screen.
  await expect(page.locator("main")).not.toContainText(
    /RRULE|FREQ=|BYDAY|COUNT=|DTSTART/,
  );
  // Years and months expose their own controls.
  await page.getByLabel("Repeat unit", { exact: true }).selectOption("years");
  await expect(page.getByLabel("Month", { exact: true })).toBeVisible();
  await page.getByLabel("Repeat unit", { exact: true }).selectOption("weeks");

  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(saved.body.schedules).toHaveLength(1);
  const rule = saved.body.schedules[0].rrule;
  expect(rule).toMatch(/^DTSTART:\d{8}T093000\nRRULE:/);
  expect(rule).toContain(
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30;BYSECOND=0;COUNT=5",
  );
  const anchor = rule.slice(0, "DTSTART:20261015T093000".length);

  await page.goto(`/schedules/${saved.body.schedules[0].id}/edit`);
  await expect(page.getByRole("radio", { name: "Custom" })).toBeChecked();
  await expect(page.getByLabel("Repeat every", { exact: true })).toHaveValue(
    "2",
  );
  await expect(page.getByLabel("Repeat unit", { exact: true })).toHaveValue(
    "weeks",
  );
  await expect(page.getByRole("checkbox", { name: "Monday" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Friday" })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Tuesday" }),
  ).not.toBeChecked();
  await expect(page.getByLabel("Ends", { exact: true })).toHaveValue("after");
  await expect(page.getByLabel("Number of sends", { exact: true })).toHaveValue(
    "5",
  );
  await expect(page.getByTestId("schedule-summary")).toContainText(
    "Every 2 weeks on Monday and Friday at 9:30 AM, Coordinated Universal Time, for 5 sends",
  );
  await page.getByLabel("Number of sends", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const reread = await browserRequest<{ schedule: ScheduleRow }>(
    page,
    `/api/schedules/${saved.body.schedules[0].id}`,
  );
  expect(reread.body.schedule.rrule).toBe(
    `${anchor}\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30;BYSECOND=0;COUNT=3`,
  );
});

test("custom builder: on the last Friday of every month until a date", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "To" }).fill("monthly@example.test");
  await page.getByLabel("Subject").fill("Month-end report");
  await page.getByRole("textbox", { name: "Message" }).fill("Report body");
  await repeatSegment(page, "Custom").click();
  await page.getByLabel("Repeat every", { exact: true }).fill("1");
  await page.getByLabel("Repeat unit", { exact: true }).selectOption("months");
  await expect(
    page.getByLabel("Week of the month", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("radio", { name: "the", exact: true }).click();
  await page
    .getByLabel("Week of the month", { exact: true })
    .selectOption("-1");
  await page.getByLabel("Weekday", { exact: true }).selectOption("FR");
  await expect(
    page.getByLabel("Day of the month", { exact: true }),
  ).toBeDisabled();
  const end = new Date(Date.now() + 120 * 86400000);
  const endIso = end.toISOString().slice(0, 10);
  await page.getByLabel("Ends", { exact: true }).selectOption("on");
  await page.getByLabel("End date", { exact: true }).fill(endIso);
  await page.getByLabel("Time", { exact: true }).fill("17:00");
  await pickTimeZone(page, "UTC", /Coordinated Universal Time/);
  const endWords = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(end);
  await expect(page.getByTestId("schedule-summary")).toContainText(
    `On the last Friday of every month at 5:00 PM, Coordinated Universal Time, until ${endWords}`,
  );
  await expect(
    page.getByTestId("next-send-preview").getByRole("listitem"),
  ).toHaveCount(lastFridaysUntil(new Date(`${endIso}T23:59:59Z`)));
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const saved = await browserRequest<{ schedules: ScheduleRow[] }>(
    page,
    "/api/schedules",
  );
  expect(saved.body.schedules[0].rrule).toBe(
    `FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0;BYSECOND=0;UNTIL=${endIso.replace(/-/g, "")}T235959`,
  );
  await page.goto(`/schedules/${saved.body.schedules[0].id}/edit`);
  await expect(page.getByRole("radio", { name: "Custom" })).toBeChecked();
  await expect(page.getByLabel("Repeat unit", { exact: true })).toHaveValue(
    "months",
  );
  await expect(
    page.getByRole("radio", { name: "the", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByLabel("Week of the month", { exact: true }),
  ).toHaveValue("-1");
  await expect(page.getByLabel("Weekday", { exact: true })).toHaveValue("FR");
  await expect(page.getByLabel("Ends", { exact: true })).toHaveValue("on");
  await expect(page.getByLabel("End date", { exact: true })).toHaveValue(
    endIso,
  );
});

test("custom builder: an end date in the past blocks saving with a plain error", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "To" }).fill("past@example.test");
  await page.getByLabel("Subject").fill("Already over");
  await page.getByRole("textbox", { name: "Message" }).fill("Body");
  await repeatSegment(page, "Custom").click();
  await page.getByLabel("Ends", { exact: true }).selectOption("on");
  await page.getByLabel("End date", { exact: true }).fill("2020-01-01");
  await expect(page.getByTestId("next-send-preview")).toContainText(
    "Finish the repeat pattern",
  );
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  await expect(
    page.getByText(
      "This schedule has no upcoming sends. Change the end date or count.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Repeat every", { exact: true })).toBeFocused();
});

test("a saved rule the builder cannot show gets a plain-English summary and a Replace action", async ({
  page,
}) => {
  const created = await browserRequest<ForecastResponse>(
    page,
    "/api/schedules",
    "POST",
    {
      subject: "Last weekday report",
      body_text: "Report body",
      to: ["lastday@example.test"],
      rrule:
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYHOUR=17;BYMINUTE=0;BYSECOND=0",
      timezone: "UTC",
    },
  );
  expect(created.status).toBe(201);
  const path = `/api/schedules/${created.body.schedule.id}`;
  await page.goto(`/schedules/${created.body.schedule.id}/edit`);
  const locked = page.getByTestId("locked-rule");
  await expect(locked).toBeVisible();
  await expect(locked).toContainText(
    "Every month on Monday, Tuesday, Wednesday, Thursday and Friday keeping only the last match at 5:00 PM, Coordinated Universal Time",
  );
  await expect(page.locator("main")).not.toContainText(
    /RRULE|FREQ=|BYSETPOS|BYDAY/,
  );
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByLabel("Time", { exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId("next-send-preview").getByRole("listitem"),
  ).toHaveCount(5);
  // Saving without touching the pattern keeps the rule verbatim.
  await page.getByLabel("Subject").fill("Last weekday report, renamed");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const kept = await browserRequest<{ schedule: ScheduleRow }>(page, path);
  expect(kept.body.schedule.subject).toBe("Last weekday report, renamed");
  expect(kept.body.schedule.rrule).toBe(created.body.schedule.rrule);

  await page.goto(`/schedules/${created.body.schedule.id}/edit`);
  await page
    .getByRole("button", { name: "Replace with a new schedule" })
    .click();
  await expect(page.getByTestId("locked-rule")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Weekly" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Weekly" })).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    "Coordinated Universal Time (UTC), UTC+0",
  );
  for (const day of WEEKDAY_NAMES) await setDay(page, day, day === "Monday");
  await page.getByLabel("Time", { exact: true }).fill("08:00");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const replaced = await browserRequest<{ schedule: ScheduleRow }>(page, path);
  expect(replaced.body.schedule.rrule).toBe(
    "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
  );
});

test.describe("time zone picker", () => {
  test.use({ timezoneId: "Asia/Karachi" });

  test("opens on the current zone with Suggested, Common and All groups and reaches every zone", async ({
    page,
  }) => {
    await page.goto("/schedules/new");
    const picker = page.getByRole("combobox", { name: "Time zone" });
    await picker.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    await picker.click();
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("time-zone-group")).toHaveText([
      "Suggested",
      "Common",
      "All",
    ]);
    const options = page.getByRole("option");
    const first = options.first();
    await expect(first).toContainText("Asia/Karachi");
    await expect(first).toHaveAttribute("aria-selected", "true");
    await expect(first).toBeInViewport();
    const activeId = await picker.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(await first.getAttribute("id")).toBe(activeId);
    const zoneCount = await page.evaluate(
      () => Intl.supportedValuesOf("timeZone").length,
    );
    expect(zoneCount).toBeGreaterThan(300);
    // Suggested + Common + All: every runtime zone is in the list, none capped.
    expect(await options.count()).toBeGreaterThanOrEqual(zoneCount);
    await expect(options.filter({ hasText: "Pacific/Tongatapu" })).toHaveCount(
      1,
    );
    await expect(options.filter({ hasText: "Pacific/Pago_Pago" })).toHaveCount(
      1,
    );
    // Keyboard: Escape closes, ArrowDown reopens on the current zone.
    await picker.press("Escape");
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await picker.press("ArrowDown");
    await expect(picker).toHaveAttribute("aria-expanded", "true");
    await expect(options.first()).toContainText("Asia/Karachi");
  });

  test("search matches abbreviations, countries and non-IANA cities", async ({
    page,
  }) => {
    await page.goto("/schedules/new");
    const picker = page.getByRole("combobox", { name: "Time zone" });
    const firstOption = page.getByRole("option").first();
    const cases: [string, RegExp][] = [
      ["PKT", /Asia\/Karachi/],
      ["Lahore", /Asia\/Karachi/],
      ["Islamabad", /Asia\/Karachi/],
      ["Pakistan", /Asia\/Karachi/],
      ["IST", /Asia\/Kolkata/],
      ["Mumbai", /Asia\/Kolkata/],
      ["Delhi", /Asia\/Kolkata/],
      ["Bangalore", /Asia\/Kolkata/],
      ["India", /Asia\/Kolkata/],
      ["EST", /America\/New_York/],
      ["EDT", /America\/New_York/],
      ["PST", /America\/Los_Angeles/],
      ["PDT", /America\/Los_Angeles/],
      ["San Francisco", /America\/Los_Angeles/],
      ["Seattle", /America\/Los_Angeles/],
      ["United States", /America\/New_York/],
      ["Toronto", /America\/Toronto/],
      ["GMT", /Europe\/London/],
      ["BST", /Europe\/London/],
      ["United Kingdom", /Europe\/London/],
      ["Germany", /Europe\/Berlin/],
      ["CET", /Europe\/(Berlin|Paris)/],
      ["UAE", /Asia\/Dubai/],
      ["JST", /Asia\/Tokyo/],
      ["AEST", /Australia\/Sydney/],
      ["Sydney", /Australia\/Sydney/],
    ];
    for (const [query, expected] of cases) {
      await picker.fill(query);
      await expect(firstOption, `query ${query}`).toContainText(expected);
    }
    await picker.fill("Lahore");
    await firstOption.click();
    await expect(picker).toHaveValue("Pakistan Time (Asia/Karachi), UTC+5");
    await picker.fill("no such place");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(
      page.getByText("No time zone matches “no such place”"),
    ).toBeVisible();
  });
});

test("leaving the editor with unsaved edits asks first, and saving clears the guard", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  const dialogs: string[] = [];
  // Untouched form: Cancel leaves without asking.
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(dialogs).toEqual([]);

  await page.goto("/schedules/new");
  await page.getByLabel("Subject").click();
  await page.getByLabel("Subject").fill("Draft subject");
  page.once("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Schedules" })
    .click();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/schedules\/new$/);
  expect(dialogs).toEqual([
    "confirm: Leave without saving? The changes to this schedule will be lost.",
  ]);
  await expect(page.getByLabel("Subject")).toHaveValue("Draft subject");

  // Browser back goes through beforeunload.
  page.once("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(dialogs).toHaveLength(2);
  expect(dialogs[1]).toBe("beforeunload");

  // Accepting the confirm leaves.
  await page.goto("/schedules/new");
  await page.getByLabel("Subject").click();
  await page.getByLabel("Subject").fill("Draft subject");
  page.once("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(dialogs).toHaveLength(3);

  // Saving navigates away without asking.
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "To" }).fill("guard@example.test");
  await page.getByLabel("Subject").fill("Guarded");
  await page.getByRole("textbox", { name: "Message" }).fill("Body");
  page.on("dialog", (dialog) => {
    dialogs.push(`unexpected ${dialog.type()}`);
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  expect(dialogs).toHaveLength(3);
});

test("closing the tab with unsaved edits triggers the browser's leave prompt", async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto("/schedules/new");
  await page.getByLabel("Subject").click();
  await page.getByLabel("Subject").fill("Draft subject");
  const dialogPromise = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
});

test("editing a message body alone marks the form as changed", async ({
  page,
}) => {
  await page.goto("/schedules/new");
  await page.getByRole("textbox", { name: "Message" }).fill("Only the body");
  let asked = false;
  page.once("dialog", (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "Cancel" }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/schedules\/new$/);
  expect(asked).toBe(true);
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
