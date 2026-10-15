import path from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

interface FakeUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}
interface GmailMessage {
  headers: Record<string, string>;
  message: string;
  text: string;
}
interface ScenarioState {
  connections: Array<{
    id: string;
    user_id: string;
    google_email: string;
    status: string;
  }>;
  schedules: Array<{
    id: string;
    user_id: string;
    gmail_connection_id: string | null;
    status: string;
  }>;
  sendLogs: unknown[];
  gmailMessages: GmailMessage[];
  testSends: Array<{ user_id: string; sent_at: string }>;
}

const RECIPIENTS = ["boss@example.test", "team@example.test"];
const COPY = "copy@example.test";

/** Point the fake Google at a scenario: a real refresh token, then the failure mode. */
async function prepare(
  request: APIRequestContext,
  scenarioId: string,
  setup: "test-send" | "expired-grant" | "gmail-failure",
  data?: { used: number },
) {
  const response = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenarioId}/${setup}`,
    data ? { data } : undefined,
  );
  expect(response.status(), `${setup} setup`).toBe(200);
}

/** Give the owner a Gmail account: their own address, or a second work one. */
async function connectOwner(
  request: APIRequestContext,
  scenarioId: string,
  setup: "account-deletion" | "second-account",
) {
  const response = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenarioId}/${setup}`,
  );
  expect(response.status(), `${setup} setup`).toBe(200);
  return (await response.json()) as { connection_id: string };
}

/** Save an active daily schedule through the API from the given account. */
async function createSchedule(
  page: Page,
  subject: string,
  connectionId: string,
) {
  const start = new Date(Date.now() + 3600000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const result = await page.evaluate(
    async ([subject, connectionId, start]) => {
      const response = await fetch("/api/schedules", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body_text: "A daily reminder.",
          to: ["daily@example.test"],
          rrule: `DTSTART:${start}\nRRULE:FREQ=DAILY`,
          timezone: "UTC",
          gmail_connection_id: connectionId,
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          schedule?: { id: string; status: string };
        },
      };
    },
    [subject, connectionId, start] as const,
  );
  expect(result.status, subject).toBe(201);
  expect(result.body.schedule?.status).toBe("active");
  return result.body.schedule?.id as string;
}

async function readState(
  request: APIRequestContext,
  scenarioId: string,
): Promise<ScenarioState> {
  const response = await request.get(
    `${fakeSupabaseUrl}/__test/scenarios/${scenarioId}`,
  );
  expect(response.status()).toBe(200);
  return response.json();
}

async function signIn(page: Page, context: BrowserContext, user: FakeUser) {
  await context.addCookies([
    testSessionCookie(user.accessToken, undefined, user.refreshToken),
  ]);
  await page.goto("/dashboard");
  await expect(page.getByText(`Signed in as ${user.email}`)).toBeVisible();
}

/** A brand-new, unsaved draft with recipients the test email must never reach. */
async function startDraft(page: Page) {
  await page.goto("/schedules/new");
  await page
    .getByRole("textbox", { name: "To" })
    .fill(`${RECIPIENTS.join(", ")} `);
  await page.getByRole("button", { name: "Add Cc" }).click();
  await page.getByRole("textbox", { name: "Cc" }).fill(`${COPY} `);
  await page.getByLabel("Subject").fill("Quarterly numbers");
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Hello from the unsaved draft.");
}

function testButton(page: Page) {
  return page.getByRole("button", { name: "Send me a test" });
}

function successToast(page: Page, email: string) {
  return page
    .getByRole("status")
    .filter({ hasText: `Test sent to ${email}. Check your inbox.` });
}

async function noHorizontalOverflow(page: Page, label: string) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(widths.document, `${label} overflows`).toBeLessThanOrEqual(
    widths.viewport,
  );
}

/** Evidence screenshots, kept out of git under the Playwright output dir. */
function shot(testInfo: TestInfo, name: string) {
  return path.join(testInfo.project.outputDir, "screenshots", `${name}.png`);
}

test("sends an unsaved draft to the signed-in user only, never to the recipients", async ({
  page,
  context,
  request,
  scenario,
}, testInfo) => {
  await prepare(request, scenario.id, "test-send");
  await signIn(page, context, scenario.connected);
  const before = await readState(request, scenario.id);
  await startDraft(page);

  const button = testButton(page);
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("test-send")).toContainText(
    `We'll send it to you at ${scenario.connected.email} from ${scenario.connected.email}.`,
  );
  await button.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shot(testInfo, "editor-button-1280"),
    fullPage: true,
  });

  // Keyboard users: focus the button and press Enter.
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(successToast(page, scenario.connected.email)).toBeVisible();
  await page.screenshot({ path: shot(testInfo, "success-toast-1280") });
  await expect(button).toHaveText("Send me a test");
  await expect(button).toBeEnabled();
  // Nothing was saved: still on the new-schedule editor.
  await expect(page).toHaveURL(/\/schedules\/new$/);

  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toHaveLength(1);
  const [sent] = after.gmailMessages;
  expect(sent.headers.to).toBe(scenario.connected.email);
  expect(sent.headers.from).toBe(scenario.connected.email);
  expect(sent.headers.subject).toBe("[Test] Quarterly numbers");
  expect(sent.headers.cc).toBeUndefined();
  expect(sent.headers.bcc).toBeUndefined();
  for (const address of [...RECIPIENTS, COPY]) {
    expect(sent.message).not.toContain(address);
    expect(sent.text).not.toContain(address);
  }
  expect(sent.text).toContain("Hello from the unsaved draft.");
  // Counted toward the test limit, never toward schedules or send history.
  expect(after.testSends).toEqual([
    {
      id: expect.any(String),
      user_id: scenario.connected.id,
      sent_at: expect.any(String),
    },
  ]);
  expect(after.schedules).toEqual(before.schedules);
  expect(after.sendLogs).toEqual([]);
});

test("offers the same button when editing an existing schedule", async ({
  page,
  context,
  request,
  scenario,
}) => {
  await prepare(request, scenario.id, "test-send");
  await signIn(page, context, scenario.connected);
  const state = await readState(request, scenario.id);
  const owned = state.schedules.find(
    (schedule) => schedule.user_id === scenario.connected.id,
  );
  expect(owned).toBeDefined();
  await page.goto(`/schedules/${owned?.id}/edit`);
  await expect(page.getByLabel("Subject")).not.toHaveValue("");
  const button = testButton(page);
  await expect(button).toBeEnabled();
  await expect(page.getByTestId("test-send")).toContainText(
    `We'll send it to you at ${scenario.connected.email}`,
  );
  // The hint is tied to the button for screen readers.
  await expect(button).toHaveAttribute("aria-describedby", "test-send-hint");
  await button.click();
  await expect(successToast(page, scenario.connected.email)).toBeVisible();
  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toHaveLength(1);
  expect(after.gmailMessages[0].headers.to).toBe(scenario.connected.email);
  expect(after.gmailMessages[0].headers.subject).toMatch(/^\[Test\] /);
});

test("stays disabled, with a hint, until the draft has a subject and a message", async ({
  page,
  context,
  request,
  scenario,
}) => {
  await prepare(request, scenario.id, "test-send");
  await signIn(page, context, scenario.connected);
  await page.goto("/schedules/new");
  const requests: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/schedules/test")
      requests.push(sent.method());
  });
  const button = testButton(page);
  const hint = page.locator("#test-send-hint");
  await expect(button).toBeDisabled();
  await expect(hint).toContainText("Add a subject and a message first.");
  // A forced click on the disabled button must not call the API.
  await button.click({ force: true });
  await expect(button).toHaveText("Send me a test");
  expect(requests).toEqual([]);

  await page.getByLabel("Subject").fill("Only a subject");
  await expect(button).toBeDisabled();
  await page.getByRole("textbox", { name: "Message" }).fill("Now a message.");
  await expect(button).toBeEnabled();
  await expect(hint).not.toContainText("Add a subject and a message first.");
  await expect(hint).toContainText(
    `We'll send it to you at ${scenario.connected.email}`,
  );
});

test("asks the user to reconnect when Gmail access has expired", async ({
  page,
  context,
  request,
  scenario,
}, testInfo) => {
  await prepare(request, scenario.id, "expired-grant");
  await signIn(page, context, scenario.connected);
  const before = await readState(request, scenario.id);
  const ownedBefore = before.schedules.filter(
    (schedule) => schedule.user_id === scenario.connected.id,
  );
  expect(ownedBefore.map((schedule) => schedule.status)).toEqual(["active"]);
  await startDraft(page);
  await testButton(page).click();
  const alert = page.getByRole("alert").filter({
    hasText: `Gmail access for ${scenario.connected.email} has expired. Reconnect it from the dashboard.`,
  });
  await expect(alert).toBeVisible();
  const reconnect = alert.getByRole("link", { name: "Reconnect Gmail" });
  await expect(reconnect).toHaveAttribute("href", "/dashboard");
  await testButton(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot(testInfo, "error-state-1280") });

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(alert).toBeVisible();
  await noHorizontalOverflow(page, "editor error state at 375px");
  await testButton(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot(testInfo, "error-state-375") });

  // Nothing was sent or counted. The dead token is recorded the way the
  // sender records it: the connection needs reconnecting and the user's
  // schedules are paused, with no send history and no reconnect email.
  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toEqual([]);
  expect(after.testSends).toEqual([]);
  expect(after.sendLogs).toEqual([]);
  const connection = after.connections.find(
    (row) => row.user_id === scenario.connected.id,
  );
  expect(connection?.status).toBe("needs_reconnect");
  const ownedAfter = after.schedules.filter(
    (schedule) => schedule.user_id === scenario.connected.id,
  );
  expect(ownedAfter.map((schedule) => schedule.id)).toEqual(
    ownedBefore.map((schedule) => schedule.id),
  );
  expect(ownedAfter.map((schedule) => schedule.status)).toEqual(["paused"]);
  // Other users' connections and schedules are untouched.
  for (const row of after.connections)
    if (row.user_id !== scenario.connected.id)
      expect(row.status).toBe(
        before.connections.find((c) => c.user_id === row.user_id)?.status,
      );
  expect(
    after.schedules.filter((s) => s.user_id !== scenario.connected.id),
  ).toEqual(
    before.schedules.filter((s) => s.user_id !== scenario.connected.id),
  );

  // Following the link: the dashboard shows the reconnect banner and action,
  // and the schedule is listed as paused until Gmail is reconnected.
  await page.setViewportSize({ width: 1280, height: 900 });
  // The draft is unsaved, so the editor asks before leaving; the user confirms.
  page.once("dialog", (dialog) => dialog.accept());
  await reconnect.click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const banner = page
    .getByRole("region", { name: "Gmail account" })
    .getByRole("alert");
  await expect(banner).toContainText("Gmail needs reconnecting");
  await expect(
    banner.getByRole("button", { name: "Reconnect Gmail", exact: true }),
  ).toBeVisible();
  // The schedule is paused and its account needs reconnecting, so the card
  // names the account to reconnect instead of offering a Resume that cannot
  // work yet; Resume comes back once the account is reconnected.
  const row = page
    .getByRole("listitem")
    .filter({ hasText: "Fixture reminder" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Status Needs reconnect");
  await expect(row).toContainText(
    `Paused until you reconnect ${scenario.connected.email}.`,
  );
  await expect(row.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await page.screenshot({ path: shot(testInfo, "dashboard-reconnect-1280") });
});

test("sends from the account chosen in From, and a dead token there leaves the other account alone", async ({
  page,
  context,
  request,
  scenario,
}, testInfo) => {
  // The owner has two accounts: their own address and a work one.
  const personal = await connectOwner(request, scenario.id, "account-deletion");
  const work = await connectOwner(request, scenario.id, "second-account");
  await signIn(page, context, scenario.owner);
  const personalSchedule = await createSchedule(
    page,
    "From the personal account",
    personal.connection_id,
  );
  const workSchedule = await createSchedule(
    page,
    "From the work account",
    work.connection_id,
  );

  await startDraft(page);
  const from = page.getByRole("combobox", { name: "From" });
  await expect(from).toHaveValue(personal.connection_id);
  await expect(page.getByTestId("test-send")).toContainText(
    `We'll send it to you at ${scenario.owner.email} from ${scenario.owner.email}.`,
  );
  await from.selectOption({ label: scenario.workEmail });
  // The hint names the account the test will go out from.
  await expect(page.getByTestId("test-send")).toContainText(
    `We'll send it to you at ${scenario.owner.email} from ${scenario.workEmail}.`,
  );
  await testButton(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shot(testInfo, "second-account-hint-1280"),
    fullPage: true,
  });
  await testButton(page).click();
  await expect(successToast(page, scenario.owner.email)).toBeVisible();

  // The email left from the work account and still only went to the owner.
  const sent = await readState(request, scenario.id);
  expect(sent.gmailMessages).toHaveLength(1);
  expect(sent.gmailMessages[0].headers.from).toBe(scenario.workEmail);
  expect(sent.gmailMessages[0].headers.to).toBe(scenario.owner.email);
  expect(sent.gmailMessages[0].headers.subject).toBe(
    "[Test] Quarterly numbers",
  );

  // Now the work account's token is dead. Only that account and the schedule
  // sending from it are affected; the personal account keeps going.
  await prepare(request, scenario.id, "expired-grant");
  await testButton(page).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: `Gmail access for ${scenario.workEmail} has expired. Reconnect it from the dashboard.`,
    }),
  ).toBeVisible();
  await testButton(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: shot(testInfo, "second-account-expired-1280"),
  });

  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toHaveLength(1);
  const status = (id: string) =>
    after.connections.find((row) => row.id === id)?.status;
  expect(status(work.connection_id)).toBe("needs_reconnect");
  expect(status(personal.connection_id)).toBe("connected");
  const schedule = (id: string) => after.schedules.find((row) => row.id === id);
  expect(schedule(workSchedule)).toMatchObject({
    gmail_connection_id: work.connection_id,
    status: "paused",
  });
  expect(schedule(personalSchedule)).toMatchObject({
    gmail_connection_id: personal.connection_id,
    status: "active",
  });
  // Nobody else's accounts or schedules moved.
  const others = (state: ScenarioState) =>
    state.connections
      .filter((row) => row.user_id !== scenario.owner.id)
      .map((row) => [row.id, row.status]);
  expect(others(after)).toEqual(others(sent));
  expect(
    after.schedules.filter((row) => row.user_id !== scenario.owner.id),
  ).toEqual(sent.schedules.filter((row) => row.user_id !== scenario.owner.id));
});

test("shows an error toast when Gmail rejects the send", async ({
  page,
  context,
  request,
  scenario,
}) => {
  await prepare(request, scenario.id, "gmail-failure");
  await signIn(page, context, scenario.connected);
  await startDraft(page);
  await testButton(page).click();
  const toast = page.getByRole("alert").filter({
    hasText: "Gmail couldn't send the test email. Try again in a moment.",
  });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await expect(toast).toHaveCount(0);
  await expect(testButton(page)).toBeEnabled();
  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toEqual([]);
  expect(after.testSends).toEqual([]);
});

test.describe("rate limit in the reader's time zone", () => {
  // The owner is in Pakistan; the retry time must read in their clock, not UTC.
  test.use({ timezoneId: "Asia/Karachi" });

  test("stops at five test emails an hour and says when to try again in local time", async ({
    page,
    context,
    request,
    scenario,
  }) => {
    await prepare(request, scenario.id, "test-send", { used: 4 });
    await signIn(page, context, scenario.connected);
    await startDraft(page);
    await testButton(page).click();
    await expect(successToast(page, scenario.connected.email)).toBeVisible();

    await testButton(page).click();
    const limit = page.getByRole("alert").filter({
      hasText: /You've sent 5 test emails in the last hour\. Try again at .+\./,
    });
    await expect(limit).toBeVisible();
    await expect(limit.getByRole("link")).toHaveCount(0);
    const after = await readState(request, scenario.id);
    expect(after.gmailMessages).toHaveLength(1);
    expect(after.testSends).toHaveLength(5);

    // The window frees up one hour after the oldest of the five sends.
    const oldest = [...after.testSends].map((row) => row.sent_at).sort()[0];
    const retryAt = new Date(Date.parse(oldest) + 3600000);
    const clock = (timeZone: string) =>
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      })
        .format(retryAt)
        .replace(/[  ]/g, " ");
    const text = (await limit.innerText()).replace(/[  ]/g, " ");
    expect(text).toBe(
      `You've sent 5 test emails in the last hour. Try again at ${clock("Asia/Karachi")}.`,
    );
    expect(text).not.toContain("UTC");
    expect(text).not.toContain(clock("UTC"));
  });
});

test("fits a 375px viewport with the button and keeps the sticky action bar", async ({
  page,
  context,
  request,
  scenario,
}, testInfo) => {
  await prepare(request, scenario.id, "test-send");
  await signIn(page, context, scenario.connected);
  await page.setViewportSize({ width: 375, height: 812 });
  await startDraft(page);
  await noHorizontalOverflow(page, "editor at 375px");
  const button = testButton(page);
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Save schedule" }),
  ).toBeInViewport();
  await page.screenshot({ path: shot(testInfo, "editor-button-375") });
  await button.click();
  await expect(successToast(page, scenario.connected.email)).toBeVisible();
  await noHorizontalOverflow(page, "editor with toast at 375px");
  await page.screenshot({ path: shot(testInfo, "success-toast-375") });
  const after = await readState(request, scenario.id);
  expect(after.gmailMessages).toHaveLength(1);
  expect(after.gmailMessages[0].headers.to).toBe(scenario.connected.email);
});
