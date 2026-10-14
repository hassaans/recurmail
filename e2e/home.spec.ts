import { expect, test } from "@playwright/test";

test("web app home route responds successfully", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "RecurMail" })).toBeVisible();
});
