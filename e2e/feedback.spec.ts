import { type BrowserContext, expect, type Page } from "@playwright/test";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

// Feedback for every schedule action, driven by real clicks: a confirmation
// before pause-all, a pending label on the clicked control, a status message
// when the action lands, paused and waiting copy in place of the next send,
// and the same on the history page.

type SessionUser = {
  accessToken: string;
  refreshToken: string;
  email: string;
};

async function signIn(context: BrowserContext, user: SessionUser) {
  await context.addCookies([
    testSessionCookie(user.accessToken, undefined, user.refreshToken),
  ]);
}

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

const daily = {
  body_text: "Feedback message",
  rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  timezone: "UTC",
};

// Hold a matching request until the test releases it, so the pending label
// can be asserted without depending on timing. The real server still answers.
async function hold(page: Page, pattern: string | RegExp, method: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) {
      await route.continue();
      return;
    }
    await held;
    await route.continue();
  });
  return release;
}

function card(page: Page, subject: string) {
  return page.getByRole("listitem").filter({ hasText: subject });
}

function status(page: Page, text: string) {
  return page.getByRole("main").getByRole("status").filter({ hasText: text });
}

test.describe("connected account", () => {
  test.beforeEach(async ({ page, context, request, scenario }) => {
    const setup = await request.post(
      `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/schedule-api`,
    );
    expect(setup.status()).toBe(200);
    await signIn(context, scenario.connected);
    await page.goto("/dashboard");
    await expect(
      page.getByText(`Signed in as ${scenario.connected.email}`),
    ).toBeVisible();
  });

  test("pause all asks first, shows a pending label, reports the count, then offers resume all", async ({
    page,
  }) => {
    for (const subject of ["Morning digest", "Friday wrap"]) {
      const created = await createSchedule(page, {
        ...daily,
        subject,
        to: ["team@example.test"],
      });
      expect(created.status).toBe(201);
    }
    await page.reload();
    await expect(page.getByText("Active", { exact: true })).toHaveCount(2);

    // Cancel changes nothing.
    await page.getByRole("button", { name: "Pause all schedules" }).click();
    const dialog = page.getByRole("dialog", { name: "Pause all 2 schedules?" });
    await expect(dialog).toContainText(
      "Nothing sends until you resume each one.",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Active", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("main").getByRole("status")).toHaveText("");

    const release = await hold(page, "**/api/schedules/pause-all", "POST");
    await page.getByRole("button", { name: "Pause all schedules" }).click();
    await dialog
      .getByRole("button", { name: "Pause all", exact: true })
      .click();
    const pendingConfirm = dialog.getByRole("button", { name: "Pausing all…" });
    await expect(pendingConfirm).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    release();
    await expect(dialog).toHaveCount(0);
    await expect(status(page, "Paused 2 schedules.")).toBeVisible();
    for (const subject of ["Morning digest", "Friday wrap"]) {
      const row = card(page, subject);
      await expect(row).toContainText("Status Paused");
      await expect(row).toContainText("Paused. Won't send until you resume.");
      await expect(row).not.toContainText("Next send");
    }
    await expect(
      page.getByRole("button", { name: "Pause all schedules" }),
    ).toHaveCount(0);

    // Everything is paused, so the toolbar offers to resume all, confirmed too.
    await page.getByRole("button", { name: "Resume all schedules" }).click();
    const resumeDialog = page.getByRole("dialog", {
      name: "Resume all 2 schedules?",
    });
    await expect(resumeDialog).toContainText(
      "Each one sends again at its next scheduled time.",
    );
    await resumeDialog
      .getByRole("button", { name: "Resume all", exact: true })
      .click();
    await expect(resumeDialog).toHaveCount(0);
    await expect(status(page, "Resumed 2 schedules.")).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Next send", { exact: true })).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Pause all schedules" }),
    ).toBeVisible();

    // The message can be dismissed by hand.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText("");
  });

  test("pausing one schedule shows Pausing… on that button, then paused copy replaces the next send", async ({
    page,
  }) => {
    for (const subject of ["Standup", "Retro"]) {
      const created = await createSchedule(page, {
        ...daily,
        subject,
        to: ["team@example.test"],
      });
      expect(created.status).toBe(201);
    }
    await page.reload();
    const standup = card(page, "Standup");
    const retro = card(page, "Retro");
    await expect(standup).toContainText("Next send");

    const release = await hold(page, "**/api/schedules/*/pause", "POST");
    await standup.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      standup.getByRole("button", { name: "Pausing…" }),
    ).toBeDisabled();
    // Only the clicked control changes label; the others just wait.
    await expect(
      retro.getByRole("button", { name: "Pause", exact: true }),
    ).toBeDisabled();
    release();
    await expect(status(page, "Paused “Standup”.")).toBeVisible();
    await expect(standup).toContainText("Status Paused");
    await expect(standup).toContainText("Paused. Won't send until you resume.");
    await expect(standup).not.toContainText("Next send");
    await expect(retro).toContainText("Status Active");
    await expect(retro).toContainText("Next send");
    await expect(
      retro.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();

    await standup.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(status(page, "Resumed “Standup”.")).toBeVisible();
    await expect(standup).toContainText("Status Active");
    await expect(standup).toContainText("Next send");
    await expect(standup).not.toContainText("Won't send");
  });

  test("a failed pause reports what to do and leaves the schedule active", async ({
    page,
  }) => {
    const created = await createSchedule(page, {
      ...daily,
      subject: "Flaky reminder",
      to: ["team@example.test"],
    });
    expect(created.status).toBe(201);
    await page.reload();
    await page.route("**/api/schedules/*/pause", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture failure" }),
      }),
    );
    const row = card(page, "Flaky reminder");
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toHaveText(
      "“Flaky reminder” could not be paused. Check your connection and try again.",
    );
    await expect(row).toContainText("Status Active");
    await expect(
      row.getByRole("button", { name: "Pause", exact: true }),
    ).toBeEnabled();
    await alert.getByRole("button", { name: "Dismiss" }).click();
    await expect(alert).toHaveCount(0);
  });

  test("deleting through the dialog shows Deleting… and then Schedule deleted", async ({
    page,
  }) => {
    const created = await createSchedule(page, {
      ...daily,
      subject: "Old reminder",
      to: ["team@example.test"],
    });
    expect(created.status).toBe(201);
    await page.reload();
    const row = card(page, "Old reminder");
    const release = await hold(page, "**/api/schedules/*", "DELETE");
    const dialog = page.getByRole("dialog", { name: "Delete this schedule?" });
    await expect(async () => {
      await row.getByRole("button", { name: "Delete" }).click();
      await expect(dialog).toBeVisible({ timeout: 1000 });
    }).toPass();
    await dialog.getByRole("button", { name: "Delete schedule" }).click();
    await expect(
      dialog.getByRole("button", { name: "Deleting…" }),
    ).toBeDisabled();
    release();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(status(page, "Schedule deleted.")).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  });

  test("the history page pauses and resumes next to Edit schedule and previews recipients", async ({
    page,
  }) => {
    const created = await createSchedule(page, {
      ...daily,
      subject: "Weekly notes",
      to: ["a@example.test", "b@example.test", "c@example.test"],
    });
    expect(created.status).toBe(201);
    await page.reload();
    await expect(card(page, "Weekly notes")).toContainText(
      "a@example.test, b@example.test and 1 more",
    );
    await page.goto(`/schedules/${created.body.schedule.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Weekly notes",
    );
    await expect(
      page.getByText("a@example.test, b@example.test and 1 more"),
    ).toBeVisible();
    const edit = page.getByRole("link", { name: "Edit schedule" });
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(edit).toBeVisible();
    await expect(pause).toBeVisible();
    const editBox = await edit.boundingBox();
    const pauseBox = await pause.boundingBox();
    if (!editBox || !pauseBox) throw new Error("header actions missing");
    expect(Math.abs(editBox.y - pauseBox.y)).toBeLessThan(editBox.height);
    await expect(page.getByText("Next send", { exact: true })).toBeVisible();

    const release = await hold(page, "**/api/schedules/*/pause", "POST");
    await pause.click();
    await expect(page.getByRole("button", { name: "Pausing…" })).toBeDisabled();
    release();
    await expect(status(page, "Paused “Weekly notes”.")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Status Paused");
    await expect(
      page.getByText("Paused. Won't send until you resume."),
    ).toBeVisible();
    await expect(page.getByText("Next send", { exact: true })).toHaveCount(0);
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(status(page, "Resumed “Weekly notes”.")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Status Active");
    await expect(page.getByText("Next send", { exact: true })).toBeVisible();
    await expect(pause).toBeEnabled();
  });

  test("app eyebrows use the homepage style: sentence case, no uppercase tracking", async ({
    page,
  }) => {
    const created = await createSchedule(page, {
      ...daily,
      subject: "Eyebrow check",
      to: ["team@example.test"],
    });
    expect(created.status).toBe(201);
    await page.goto("/");
    const home = page.getByText("Recurring email for Gmail", { exact: true });
    await expect(home).toHaveCSS("text-transform", "none");
    const homeStyle = await home.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        color: style.color,
      };
    });
    const eyebrows: Array<[string, string]> = [
      ["/dashboard", "Send from your own Gmail"],
      ["/settings", "Account"],
      [`/schedules/${created.body.schedule.id}`, "Schedule"],
    ];
    for (const [route, text] of eyebrows) {
      await page.goto(route);
      const eyebrow = page
        .getByRole("main")
        .locator("p", { hasText: new RegExp(`^${text}$`) });
      await expect(eyebrow).toHaveText(text);
      await expect(eyebrow).toHaveCSS("text-transform", "none");
      const style = await eyebrow.evaluate((element) => {
        const computed = getComputedStyle(element);
        return {
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          letterSpacing: computed.letterSpacing,
          color: computed.color,
        };
      });
      expect(style, route).toEqual(homeStyle);
    }
  });
});

test.describe("disconnect", () => {
  test("reports a failed disconnect inside the dialog, then shows Disconnecting… until the dashboard confirms", async ({
    page,
    context,
    request,
    scenario,
  }) => {
    // The owner gets a real encrypted token so the disconnect can complete.
    const setup = await request.post(
      `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/account-deletion`,
    );
    expect(setup.status()).toBe(200);
    await signIn(context, scenario.owner);
    await page.goto("/dashboard");
    await expect(
      page.getByText(`Signed in as ${scenario.owner.email}`),
    ).toBeVisible();

    // First attempt: the request never reaches the server.
    const disconnectRoute = /\/api\/gmail\/disconnect(\?|$)/;
    await page.route(disconnectRoute, (route) => route.abort());
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: `Disconnect ${scenario.owner.email}?`,
    });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "That could not finish. Check your connection and try again.",
    );
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect(
      dialog.getByRole("button", { name: "Disconnect", exact: true }),
    ).toBeEnabled();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.unroute(disconnectRoute);

    // Second attempt from the same dialog: held so the pending state is
    // visible, then released to the real server.
    const release = await hold(page, disconnectRoute, "POST");
    await dialog
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Disconnecting…" }),
    ).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    release();
    await expect(page).toHaveURL(
      `http://127.0.0.1:3100/dashboard?gmail=disconnected&email=${encodeURIComponent(scenario.owner.email)}`,
    );
    await expect(
      status(page, `Disconnected ${scenario.owner.email}.`),
    ).toContainText("Its schedules are paused.");
    await expect(
      page.getByRole("button", { name: "Connect Gmail", exact: true }),
    ).toBeVisible();
  });
});

test.describe("without a working Gmail connection", () => {
  test("cards without a sender say so and the connect card is the only call to action", async ({
    page,
    context,
    scenario,
  }) => {
    await signIn(context, scenario.owner);
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: "Connect Gmail to start sending" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "New schedule" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "New schedule" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Send from your own Gmail", { exact: true }),
    ).toHaveCSS("text-transform", "none");

    // The owner fixture has two paused schedules whose sender was removed.
    // With no account to choose from, there is nothing to do on them yet.
    const noSender = card(page, "No sender. Choose a Gmail account.");
    await expect(noSender).toHaveCount(2);
    await expect(noSender.first()).toContainText("Status No sender");
    await expect(noSender.last()).toContainText("Status No sender");
    await expect(noSender.first()).not.toContainText("Next send");
    await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Choose sender" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toHaveCount(0);
  });

  test("a reconnect user with schedules sees the banner and a list marked paused until reconnect", async ({
    page,
    context,
    scenario,
  }) => {
    await signIn(context, scenario.reconnect);
    await page.goto("/dashboard");
    const banner = page
      .getByRole("region", { name: "Gmail account" })
      .getByRole("alert");
    await expect(banner).toContainText("Gmail needs reconnecting");
    await expect(
      banner.getByRole("button", { name: "Reconnect Gmail", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "New schedule" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "New schedule" }),
    ).toHaveCount(0);

    const row = card(page, "Fixture reminder");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Status Needs reconnect");
    await expect(row).toContainText(
      `Paused until you reconnect ${scenario.reconnect.email}.`,
    );
    await expect(row).not.toContainText("Next send");
    await expect(
      row.getByRole("link", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await expect(row.getByRole("link", { name: "History" })).toBeVisible();

    // Pausing still works while the account needs reconnecting. The row
    // keeps asking for the reconnect and does not offer Resume until then.
    await row.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(status(page, "Paused “Fixture reminder”.")).toBeVisible();
    await expect(row).toContainText("Status Needs reconnect");
    await expect(row).toContainText(
      `Paused until you reconnect ${scenario.reconnect.email}.`,
    );
    await expect(
      row.getByRole("button", { name: "Resume", exact: true }),
    ).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: "Pause", exact: true }),
    ).toHaveCount(0);
  });
});
