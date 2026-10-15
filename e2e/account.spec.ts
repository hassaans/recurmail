import { expect } from "@playwright/test";
import { fakeSupabaseUrl, test, testSessionCookie } from "./fixtures/auth";

test("account settings delete the signed-in user's account and related rows", async ({
  page,
  context,
  request,
  scenario,
}) => {
  const setup = await request.post(
    fakeSupabaseUrl + "/__test/scenarios/" + scenario.id + "/account-deletion",
  );
  expect(setup.status(), await setup.text()).toBe(200);
  // A second account on the same user, so deletion has two tokens to revoke.
  const second = await request.post(
    fakeSupabaseUrl + "/__test/scenarios/" + scenario.id + "/second-account",
  );
  expect(second.status(), await second.text()).toBe(200);
  const secondToken = ((await second.json()) as { refresh_token: string })
    .refresh_token;
  await context.addCookies([
    testSessionCookie(
      scenario.owner.accessToken,
      undefined,
      scenario.owner.refreshToken,
    ),
  ]);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Delete account" }),
  ).toBeVisible();
  await page.getByLabel("Type delete to confirm").fill("delete");
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/?account=deleted$/);

  const snapshotResponse = await request.get(
    fakeSupabaseUrl + "/__test/scenarios/" + scenario.id,
  );
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json();
  expect(snapshot.deletedUserIds).toContain(scenario.owner.id);
  expect(snapshot.revokedTokens).toHaveLength(2);
  expect(snapshot.revokedTokens).toEqual(
    expect.arrayContaining([scenario.gmailRefreshToken, secondToken]),
  );
  expect(
    snapshot.connections.map((row: { user_id: string }) => row.user_id),
  ).not.toContain(scenario.owner.id);
  expect(
    snapshot.schedules.map((row: { user_id: string }) => row.user_id),
  ).not.toContain(scenario.owner.id);
  expect(
    snapshot.schedules.some(
      (row: { user_id: string }) => row.user_id === scenario.foreignUserId,
    ),
  ).toBe(true);
  expect(
    (await context.cookies()).some((cookie) => cookie.name === "rm_session"),
  ).toBe(false);
});
