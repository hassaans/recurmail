import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
} from "@playwright/test";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import {
  fakeSupabaseUrl,
  type Scenario,
  test,
  testSessionCookie,
} from "./fixtures/auth";

// Several Gmail accounts on one RecurMail account: adding one from Google's
// chooser, choosing which one each schedule sends from, a daily-limit
// forecast per account, disconnecting one without touching the others, and a
// reconnect that comes back as a different account than the one hinted.

const connectScope = "openid email https://www.googleapis.com/auth/gmail.send";
const screenshotDir = resolve(__dirname, "../test-results/screenshots");
const appOrigin = "http://127.0.0.1:3100";

type SessionUser = { accessToken: string; refreshToken: string };

type ScheduleResponse = {
  schedule: ScheduleRow;
  dailyLimitCheck?: { status: string; count: number; limit: number };
  warning?: string;
  error?: { code: string; message: string };
};

type Snapshot = {
  connections: {
    id: string;
    user_id: string;
    google_email: string;
    status: string;
    encrypted_refresh_token: string;
  }[];
  schedules: ScheduleRow[];
  revokedTokens: string[];
  exchanges: { scope: string; pkceVerified: boolean; email?: string }[];
};

async function signIn(context: BrowserContext, user: SessionUser) {
  await context.addCookies([
    testSessionCookie(user.accessToken, undefined, user.refreshToken),
  ]);
}

/** Which account the fake Google chooser picks at the next consent. */
async function grant(
  request: APIRequestContext,
  scenario: Scenario,
  email: string,
) {
  const response = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/grant`,
    { data: { email } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { email: string; refresh_token: string };
}

async function setup(
  request: APIRequestContext,
  scenario: Scenario,
  name: "account-deletion" | "second-account",
) {
  const response = await request.post(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/${name}`,
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as {
    connection_id: string;
    refresh_token?: string;
  };
}

async function snapshot(request: APIRequestContext, scenario: Scenario) {
  const response = await request.get(
    `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as Snapshot;
}

async function api(
  page: Page,
  method: "POST" | "PATCH",
  path: string,
  data: object,
) {
  return page.evaluate(
    async ([method, path, data]) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return {
        status: response.status,
        body: (await response.json()) as ScheduleResponse,
      };
    },
    [method, path, data] as const,
  );
}

function dailyInput(recipientCount: number, extra: object = {}) {
  const recipients = Array.from(
    { length: recipientCount },
    (_, index) => `daily${index}@example.test`,
  );
  const start = new Date(Date.now() + 3600000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return {
    subject: `Daily to ${recipientCount}`,
    body_text: "A daily reminder.",
    to: recipients,
    rrule: `DTSTART:${start}\nRRULE:FREQ=DAILY`,
    timezone: "UTC",
    ...extra,
  };
}

function accountsRegion(page: Page) {
  return page.getByRole("region", { name: "Gmail accounts", exact: true });
}

function accountRow(page: Page, email: string) {
  return accountsRegion(page).getByRole("listitem").filter({ hasText: email });
}

function scheduleCard(page: Page, subject: string) {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ hasText: subject });
}

function notice(page: Page, text: string) {
  return page.getByRole("main").getByRole("status").filter({ hasText: text });
}

/** The From field of the editor: label, select and hint. */
function fromField(page: Page) {
  return page.locator("#sender").locator("xpath=ancestor::div[2]");
}

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test("adds a second Gmail account from Google's chooser, names it, and lets each schedule pick its sender", async ({
  page,
  context,
  request,
  scenario,
}) => {
  await mkdir(screenshotDir, { recursive: true });
  await signIn(context, scenario.owner);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Connect Gmail to start sending" }),
  ).toBeVisible();

  // First account: the fake chooser picks the owner's own address.
  await page
    .getByRole("button", { name: "Connect Gmail", exact: true })
    .click();
  await expect(page).toHaveURL(
    `${appOrigin}/dashboard?gmail=connected&email=${encodeURIComponent(scenario.owner.email)}`,
  );
  await expect(notice(page, "Connected ")).toContainText(
    `Connected ${scenario.owner.email}. RecurMail can send your scheduled emails from it.`,
  );
  await expect(accountsRegion(page).getByRole("listitem")).toHaveCount(1);
  await expect(accountRow(page, scenario.owner.email)).toContainText(
    "Connected",
  );

  // Second account: no login_hint, so Google shows its chooser, and the
  // account that granted is the one that gets connected and named.
  await grant(request, scenario, scenario.workEmail);
  await page
    .getByRole("button", { name: "Add another Gmail account", exact: true })
    .click();
  await expect(page).toHaveURL(
    `${appOrigin}/dashboard?gmail=connected&email=${encodeURIComponent(scenario.workEmail)}`,
  );
  await expect(notice(page, "Connected ")).toContainText(
    `Connected ${scenario.workEmail}.`,
  );
  await expect(accountsRegion(page).getByRole("listitem")).toHaveCount(2);
  await expect(accountRow(page, scenario.workEmail)).toContainText("Connected");
  const connected = await snapshot(request, scenario);
  expect(connected.exchanges).toEqual([
    { scope: connectScope, pkceVerified: true, email: scenario.owner.email },
    { scope: connectScope, pkceVerified: true, email: scenario.workEmail },
  ]);
  const owned = connected.connections.filter(
    (row) => row.user_id === scenario.owner.id,
  );
  expect(owned.map((row) => row.google_email)).toEqual([
    scenario.owner.email,
    scenario.workEmail,
  ]);
  const work = owned.find((row) => row.google_email === scenario.workEmail);
  if (!work) throw new Error("work account was not saved");

  // The owner's old schedules lost their sender; they now offer to choose one.
  const noSender = scheduleCard(page, "No sender. Choose a Gmail account.");
  await expect(noSender).toHaveCount(2);
  await expect(
    noSender.first().getByRole("link", { name: "Choose sender" }),
  ).toBeVisible();

  await accountsRegion(page).screenshot({
    path: resolve(screenshotDir, "gmail-accounts-1280.png"),
  });
  await page.screenshot({
    path: resolve(screenshotDir, "dashboard-1280.png"),
    fullPage: true,
  });

  // The editor's From field lists both accounts and starts on the first one.
  await page.goto("/schedules/new");
  const from = page.getByRole("combobox", { name: "From" });
  await expect(from).toHaveValue(owned[0].id);
  await expect(from.getByRole("option")).toHaveText([
    scenario.owner.email,
    scenario.workEmail,
  ]);
  await expect(
    page.getByText("Recipients see this address as the sender."),
  ).toBeVisible();
  await from.selectOption({ label: scenario.workEmail });
  await expect(from).toHaveValue(work.id);
  await fromField(page).screenshot({
    path: resolve(screenshotDir, "editor-from-1280.png"),
  });
  await page.getByRole("textbox", { name: "To" }).fill("team@example.test");
  await page.getByLabel("Subject").fill("Work update");
  await page.getByRole("textbox", { name: "Message" }).fill("From work.");
  await page.getByText("Daily", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Daily" })).toBeChecked();
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  const saved = scheduleCard(page, "Work update");
  await expect(saved).toContainText("Status Active");
  await expect(saved).toContainText(`From ${scenario.workEmail}`);
  const after = await snapshot(request, scenario);
  expect(
    after.schedules.find((row) => row.subject === "Work update"),
  ).toMatchObject({ status: "active", gmail_connection_id: work.id });

  // The same screens on a phone, without sideways scrolling.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/dashboard");
  await expect(accountsRegion(page)).toBeVisible();
  await noHorizontalOverflow(page);
  await accountsRegion(page).screenshot({
    path: resolve(screenshotDir, "gmail-accounts-375.png"),
  });
  await page.screenshot({
    path: resolve(screenshotDir, "dashboard-375.png"),
    fullPage: true,
  });
  await page.goto("/schedules/new");
  await expect(page.getByRole("combobox", { name: "From" })).toBeVisible();
  await noHorizontalOverflow(page);
  await fromField(page).screenshot({
    path: resolve(screenshotDir, "editor-from-375.png"),
  });
});

test("forecasts the personal daily recipient limit per sending account", async ({
  page,
  context,
  request,
  scenario,
}) => {
  const personal = await setup(request, scenario, "account-deletion");
  const work = await setup(request, scenario, "second-account");
  await signIn(context, scenario.owner);

  // Saved from the editor on the personal account: 400 of 500 is a warning
  // that names the account.
  await page.goto("/schedules/new");
  const from = page.getByRole("combobox", { name: "From" });
  await expect(from).toHaveValue(personal.connection_id);
  const recipients = Array.from(
    { length: 400 },
    (_, index) => `daily${index}@example.test`,
  );
  await page.getByRole("textbox", { name: "To" }).fill(recipients.join(", "));
  await page.getByLabel("Subject").fill("Daily limit warning");
  await page.getByRole("textbox", { name: "Message" }).fill("Daily message");
  await page.getByText("Daily", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Daily" })).toBeChecked();
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  await expect(
    page.getByText(
      `Personal Gmail daily recipient limit forecast for ${scenario.owner.email} is warn (400/500).`,
      { exact: true },
    ),
  ).toBeVisible();

  // The same volume on the work account is well inside its own limit, and
  // the personal account's schedules do not count against it.
  const onWork = await api(
    page,
    "POST",
    "/api/schedules",
    dailyInput(400, { gmail_connection_id: work.connection_id }),
  );
  expect(onWork.status, JSON.stringify(onWork.body)).toBe(201);
  expect(onWork.body.schedule.gmail_connection_id).toBe(work.connection_id);
  expect(onWork.body.dailyLimitCheck).toMatchObject({
    status: "ok",
    count: 400,
    limit: 2000,
  });
  expect(onWork.body.warning).toBeUndefined();

  // More on the personal account adds to that account's own forecast only.
  const morePersonal = await api(
    page,
    "POST",
    "/api/schedules",
    dailyInput(150, { gmail_connection_id: personal.connection_id }),
  );
  expect(morePersonal.status, JSON.stringify(morePersonal.body)).toBe(201);
  expect(morePersonal.body.dailyLimitCheck).toMatchObject({
    status: "over",
    count: 550,
    limit: 500,
  });
  expect(morePersonal.body.warning).toBe(
    `Personal Gmail daily recipient limit forecast for ${scenario.owner.email} is over (550/500).`,
  );

  // A sender that is not one of the user's accounts is refused plainly.
  const foreign = await api(
    page,
    "POST",
    "/api/schedules",
    dailyInput(1, { gmail_connection_id: scenario.connectionIds.connected }),
  );
  expect(foreign.status).toBe(400);
  expect(foreign.body.error).toEqual({
    code: "sender_required",
    message: "Choose one of your connected Gmail accounts",
  });
});

test("disconnecting one account pauses only its schedules and the other account keeps sending", async ({
  page,
  context,
  request,
  scenario,
}) => {
  const personal = await setup(request, scenario, "account-deletion");
  const work = await setup(request, scenario, "second-account");
  await signIn(context, scenario.owner);
  await page.goto("/dashboard");
  const fromPersonal = await api(
    page,
    "POST",
    "/api/schedules",
    dailyInput(1, {
      subject: "From the personal account",
      gmail_connection_id: personal.connection_id,
    }),
  );
  expect(fromPersonal.status, JSON.stringify(fromPersonal.body)).toBe(201);
  const fromWork = await api(
    page,
    "POST",
    "/api/schedules",
    dailyInput(1, {
      subject: "From the work account",
      gmail_connection_id: work.connection_id,
    }),
  );
  expect(fromWork.status, JSON.stringify(fromWork.body)).toBe(201);
  await page.goto("/dashboard");
  const personalCard = scheduleCard(page, "From the personal account");
  const workCard = scheduleCard(page, "From the work account");
  await expect(personalCard).toContainText("Status Active");
  await expect(personalCard).toContainText(`From ${scenario.owner.email}`);
  await expect(workCard).toContainText("Status Active");
  await expect(workCard).toContainText(`From ${scenario.workEmail}`);

  // Disconnect the work account from its own row. The dialog says what pauses.
  await accountRow(page, scenario.workEmail)
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: `Disconnect ${scenario.workEmail}?`,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    `RecurMail will give up its permission to send from ${scenario.workEmail} and remove it from your account. 1 schedule will pause until you choose another account for it.`,
  );
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page).toHaveURL(
    `${appOrigin}/dashboard?gmail=disconnected&email=${encodeURIComponent(scenario.workEmail)}`,
  );
  await expect(notice(page, "Disconnected ")).toContainText(
    `Disconnected ${scenario.workEmail}. Its schedules are paused.`,
  );
  await expect(accountsRegion(page).getByRole("listitem")).toHaveCount(1);
  await expect(accountRow(page, scenario.owner.email)).toContainText(
    "Connected",
  );

  // Its schedule has no sender and cannot resume until one is chosen. The
  // personal account's schedule is untouched.
  await expect(workCard).toContainText("Status No sender");
  await expect(workCard).toContainText("No sender. Choose a Gmail account.");
  await expect(workCard).not.toContainText("Next send");
  await expect(
    workCard.getByRole("button", { name: "Resume", exact: true }),
  ).toHaveCount(0);
  await expect(
    workCard.getByRole("link", { name: "Choose sender" }),
  ).toHaveAttribute("href", `/schedules/${fromWork.body.schedule.id}/edit`);
  await expect(personalCard).toContainText("Status Active");
  await expect(personalCard).not.toContainText("No sender");
  const afterDisconnect = await snapshot(request, scenario);
  expect(
    afterDisconnect.schedules.find(
      (row) => row.id === fromWork.body.schedule.id,
    ),
  ).toMatchObject({ status: "paused", gmail_connection_id: null });
  expect(
    afterDisconnect.schedules.find(
      (row) => row.id === fromPersonal.body.schedule.id,
    ),
  ).toMatchObject({
    status: "active",
    gmail_connection_id: personal.connection_id,
  });
  expect(afterDisconnect.revokedTokens).toEqual([work.refresh_token]);
  expect(afterDisconnect.connections.map((row) => row.id)).not.toContain(
    work.connection_id,
  );
  expect(afterDisconnect.connections.map((row) => row.id)).toContain(
    personal.connection_id,
  );

  // Choosing a sender in the editor makes the schedule resumable, and
  // resuming it needs that sender to be connected.
  await workCard.getByRole("link", { name: "Choose sender" }).click();
  await expect(page).toHaveURL(
    `${appOrigin}/schedules/${fromWork.body.schedule.id}/edit`,
  );
  const from = page.getByRole("combobox", { name: "From" });
  await expect(from).toHaveValue("");
  await expect(from.getByRole("option")).toHaveText([
    "Choose a Gmail account",
    scenario.owner.email,
  ]);
  await expect(
    page.getByText("No sender. Choose a Gmail account.", { exact: true }),
  ).toBeVisible();
  await from.selectOption({ label: scenario.owner.email });
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page).toHaveURL(/\/dashboard\?saved=1/);
  await expect(workCard).toContainText("Status Paused");
  await expect(workCard).toContainText("Paused. Won't send until you resume.");
  await workCard.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(workCard).toContainText("Status Active");
  const resumed = await snapshot(request, scenario);
  expect(
    resumed.schedules.find((row) => row.id === fromWork.body.schedule.id),
  ).toMatchObject({
    status: "active",
    gmail_connection_id: personal.connection_id,
  });
});

test("reconnecting saves whichever account Google granted, then re-granting the hinted one updates it in place", async ({
  page,
  context,
  request,
  scenario,
}) => {
  await signIn(context, scenario.reconnect);
  await page.goto("/dashboard");
  const banner = page
    .getByRole("region", { name: "Gmail account", exact: true })
    .getByRole("alert");
  await expect(banner).toContainText("Gmail needs reconnecting");
  await expect(banner).toContainText(
    "Reconnect Gmail, then resume the schedules it paused.",
  );
  const hinted = accountRow(page, scenario.reconnect.email);
  await expect(hinted).toContainText("Needs reconnect");
  const row = scheduleCard(page, "Fixture reminder");
  await expect(row).toContainText("Status Needs reconnect");

  // The user picks a different account on Google's screen than the one the
  // reconnect hinted. That account is saved as its own connection; the
  // hinted one still needs reconnecting, and its schedule stays paused.
  const other = `other-${scenario.reconnect.id}@gmail.com`;
  await grant(request, scenario, other);
  await hinted.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page).toHaveURL(
    `${appOrigin}/dashboard?gmail=connected&email=${encodeURIComponent(other)}`,
  );
  await expect(notice(page, "Connected ")).toContainText(`Connected ${other}.`);
  await expect(accountsRegion(page).getByRole("listitem")).toHaveCount(2);
  await expect(accountRow(page, other)).toContainText("Connected");
  await expect(hinted).toContainText("Needs reconnect");
  await expect(banner).toHaveCount(0);
  await expect(row).toContainText("Status Needs reconnect");
  await expect(row).toContainText(
    `Paused until you reconnect ${scenario.reconnect.email}.`,
  );
  await expect(page.getByRole("link", { name: "New schedule" })).toBeVisible();
  const afterOther = await snapshot(request, scenario);
  expect(afterOther.exchanges).toEqual([
    { scope: connectScope, pkceVerified: true, email: other },
  ]);
  const mine = (snap: Snapshot) =>
    snap.connections.filter((row) => row.user_id === scenario.reconnect.id);
  expect(mine(afterOther).map((row) => [row.google_email, row.status])).toEqual(
    [
      [scenario.reconnect.email, "needs_reconnect"],
      [other, "connected"],
    ],
  );

  // Granting the hinted account itself updates that row: a fresh token,
  // connected again, no duplicate. The schedule the failed send paused stays
  // paused, as the banner said, until the user resumes it.
  await grant(request, scenario, scenario.reconnect.email);
  await hinted.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page).toHaveURL(
    `${appOrigin}/dashboard?gmail=connected&email=${encodeURIComponent(scenario.reconnect.email)}`,
  );
  await expect(accountsRegion(page).getByRole("listitem")).toHaveCount(2);
  await expect(hinted).toContainText("Connected");
  await expect(hinted).not.toContainText("Needs reconnect");
  await expect(row).toContainText("Status Paused");
  await expect(row).toContainText("Paused. Won't send until you resume.");
  const afterHinted = await snapshot(request, scenario);
  const updated = mine(afterHinted).find(
    (row) => row.google_email === scenario.reconnect.email,
  );
  expect(updated).toMatchObject({
    id: scenario.connectionIds.reconnect,
    status: "connected",
  });
  expect(updated?.encrypted_refresh_token).not.toBe("fixture-ciphertext");
  expect(mine(afterHinted)).toHaveLength(2);
  const theirs = (snap: Snapshot) =>
    snap.schedules.filter((row) => row.user_id === scenario.reconnect.id);
  expect(theirs(afterHinted)).toHaveLength(1);
  expect(theirs(afterHinted)[0]).toMatchObject({
    status: "paused",
    gmail_connection_id: scenario.connectionIds.reconnect,
  });

  // The callback redirect is a full page load, so retry the click until the
  // row reports active and a click before hydration is not lost.
  await expect(async () => {
    const resume = row.getByRole("button", { name: "Resume", exact: true });
    if (await resume.count()) await resume.click({ timeout: 1000 });
    await expect(row).toContainText("Status Active", { timeout: 1000 });
  }).toPass();
  await expect(row).toContainText("Next send");
  expect(theirs(await snapshot(request, scenario))[0]).toMatchObject({
    status: "active",
    gmail_connection_id: scenario.connectionIds.reconnect,
  });
});
