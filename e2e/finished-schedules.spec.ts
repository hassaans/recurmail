import { type BrowserContext, expect, type Page } from "@playwright/test";
import type { ScheduleRow } from "../apps/web/lib/schedules";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

// Schedules whose rule has run out. The cron paused them after the last send,
// so the dashboard and history page call them finished, hide Resume, and
// offer Edit to restart. Saving a rule with a future send starts them again.

type SessionUser = {
  accessToken: string;
  refreshToken: string;
  email: string;
};

type FinishedFixture = { counted: string; dated: string; ended_on: string };

async function signIn(context: BrowserContext, user: SessionUser) {
  await context.addCookies([
    testSessionCookie(user.accessToken, undefined, user.refreshToken),
  ]);
}

function card(page: Page, subject: string) {
  return page.getByRole("listitem").filter({ hasText: subject });
}

/** "Oct 14", with the year when the end date is not in the current year. */
function endedOnLabel(endDay: string, now = new Date()): string {
  const date = new Date(`${endDay}T23:59:59Z`);
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

async function readSchedule(page: Page, id: string) {
  return page.evaluate(async (scheduleId) => {
    const response = await fetch(`/api/schedules/${scheduleId}`, {
      credentials: "same-origin",
    });
    return (await response.json()) as { schedule: ScheduleRow };
  }, id);
}

test.describe("finished schedules", () => {
  let fixture: FinishedFixture;

  test.beforeEach(async ({ context, request, scenario }) => {
    const setup = await request.post(
      `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}/finished-schedules`,
    );
    expect(setup.status()).toBe(200);
    fixture = (await setup.json()) as FinishedFixture;
    await signIn(context, scenario.connected);
  });

  test("the dashboard calls them finished, hides Resume and offers Edit to restart", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const quarterly = card(page, "Quarterly reminder");
    await expect(quarterly.getByText("Status Finished")).toBeVisible();
    await expect(quarterly).toContainText("Finished. Sent 3 of 3.");
    await expect(quarterly.getByRole("button", { name: "Resume" })).toHaveCount(
      0,
    );
    await expect(
      quarterly.getByRole("link", { name: "Edit to restart" }),
    ).toHaveAttribute("href", `/schedules/${fixture.counted}/edit`);

    const countdown = card(page, "Launch countdown");
    await expect(countdown.getByText("Status Finished")).toBeVisible();
    await expect(countdown).toContainText(
      `Finished. Ended on ${endedOnLabel(fixture.ended_on)}.`,
    );
    await expect(countdown.getByRole("button", { name: "Resume" })).toHaveCount(
      0,
    );
    await expect(
      countdown.getByRole("link", { name: "Edit to restart" }),
    ).toBeVisible();
    await expect(page.locator("main")).not.toContainText(
      "Won't send until you resume",
    );

    // A schedule the user pauses is still just paused: it keeps Resume, and
    // "Resume all" counts it alone because the finished ones cannot resume.
    const fixtureCard = card(page, "Fixture reminder");
    await fixtureCard
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await expect(fixtureCard.getByText("Status Paused")).toBeVisible();
    await expect(fixtureCard).toContainText(
      "Paused. Won't send until you resume.",
    );
    await expect(
      fixtureCard.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await expect(fixtureCard.getByRole("link", { name: "Edit" })).toHaveText(
      "Edit",
    );
    await page.getByRole("button", { name: "Resume all schedules" }).click();
    const dialog = page.getByRole("dialog", { name: "Resume this schedule?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("Edit to restart opens the editor and a rule with future sends makes it active", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await card(page, "Quarterly reminder")
      .getByRole("link", { name: "Edit to restart" })
      .click();
    await expect(page).toHaveURL(`/schedules/${fixture.counted}/edit`);
    await expect(page.getByRole("radio", { name: "Custom" })).toBeChecked();
    await expect(page.getByLabel("Ends", { exact: true })).toHaveValue("after");
    await expect(
      page.getByLabel("Number of sends", { exact: true }),
    ).toHaveValue("3");
    await page.getByLabel("Ends", { exact: true }).selectOption("never");
    await expect(
      page.getByTestId("next-send-preview").getByRole("listitem").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page).toHaveURL(/\/dashboard\?saved=1/);

    // The saved notice has a close button and leaves when clicked.
    const notice = page
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: "Schedule saved." });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);

    const quarterly = card(page, "Quarterly reminder");
    await expect(quarterly.getByText("Status Active")).toBeVisible();
    await expect(quarterly).toContainText("Next send");
    await expect(quarterly).not.toContainText("Finished");
    await expect(
      quarterly.getByRole("button", { name: "Pause", exact: true }),
    ).toBeVisible();
    await expect(quarterly.getByRole("link", { name: "Edit" })).toHaveText(
      "Edit",
    );
    const reread = await readSchedule(page, fixture.counted);
    expect(reread.schedule.status).toBe("active");
    expect(reread.schedule.rrule).not.toContain("COUNT=");
    expect(new Date(reread.schedule.next_send_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  test("the history page header says finished and offers Edit to restart", async ({
    page,
  }) => {
    await page.goto(`/schedules/${fixture.counted}`);
    await expect(
      page.getByRole("heading", { name: "Quarterly reminder" }),
    ).toBeVisible();
    await expect(page.getByText("Status Finished")).toBeVisible();
    await expect(page.getByText("Finished. Sent 3 of 3.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Edit to restart" }),
    ).toHaveAttribute("href", `/schedules/${fixture.counted}/edit`);
    await expect(page.getByText("Sent", { exact: true })).toHaveCount(3);
    await expect(page.locator("main")).not.toContainText("Next send");

    await page.goto(`/schedules/${fixture.dated}`);
    await expect(
      page.getByRole("heading", { name: "Launch countdown" }),
    ).toBeVisible();
    await expect(page.getByText("Status Finished")).toBeVisible();
    await expect(
      page.getByText(`Finished. Ended on ${endedOnLabel(fixture.ended_on)}.`),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Edit to restart" }),
    ).toBeVisible();
  });
});
