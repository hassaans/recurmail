import { expect } from "@playwright/test";
import { test, testSessionCookie } from "./fixtures/auth";

test("a signed-in non-owner gets a 404 from the admin page", async ({
  page,
  scenario,
}) => {
  await page
    .context()
    .addCookies([testSessionCookie(scenario.owner.accessToken)]);
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
});
