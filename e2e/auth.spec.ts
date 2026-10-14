import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import {
  fakeSupabaseUrl,
  test,
  testEncryptionKey,
  testSessionCookie,
} from "./fixtures/auth";

test("signed-out visitor sees Google sign-in on the dashboard", async ({
  page,
}) => {
  const response = await page.goto("/dashboard");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your Gmail connection",
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toHaveAttribute("href", "/auth/signin");
  await expect(
    page.getByText("Gmail is a trademark of Google LLC.", { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("Google sign-in callback with fake Supabase leads to Connect Gmail without provider tokens in the page", async ({
  page,
  context,
  scenario,
}) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByText(`Signed in as ${scenario.owner.email}`),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Gmail", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Connect the same Google account you used to sign in", {
      exact: false,
    }),
  ).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("fake-google-access");
  expect(html).not.toContain("fake-google-refresh");
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === "rm_session")?.httpOnly).toBe(
    true,
  );
  expect(JSON.stringify(cookies)).not.toContain("fake-google");
});

test("Connect Gmail uses the signed-in email and permission denial explains the need and offers retry", async ({
  page,
  context,
  scenario,
}) => {
  await context.addCookies([
    testSessionCookie(
      scenario.owner.accessToken,
      undefined,
      scenario.owner.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  let consentUrl = "";
  // Exercise the real POST, stopping at the external Google redirect boundary.
  await page.route("**/api/gmail/connect", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(303);
    const responseHeaders = response.headers();
    consentUrl = responseHeaders.location;
    delete responseHeaders.location;
    await route.fulfill({
      response,
      status: 200,
      headers: { ...responseHeaders, "content-type": "text/html" },
      body: "<p>Fake Google consent</p>",
    });
  });
  await page
    .getByRole("button", { name: "Connect Gmail", exact: true })
    .click();
  await expect(page.getByText("Fake Google consent")).toBeVisible();
  const consent = new URL(consentUrl);
  expect(consent.origin).toBe(fakeSupabaseUrl);
  expect(consent.searchParams.get("scope")).toBe(
    "https://www.googleapis.com/auth/gmail.send",
  );
  expect(consent.searchParams.get("login_hint")).toBe(scenario.owner.email);
  expect(consent.searchParams.get("access_type")).toBe("offline");
  expect(consent.searchParams.get("prompt")).toBe("consent");
  const callback = new URL(consent.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", consent.searchParams.get("state") ?? "");
  callback.searchParams.set("error", "access_denied");
  await page.goto(callback.toString());
  await expect(page.getByRole("status")).toContainText(
    "RecurMail needs permission to send your scheduled emails",
  );
  await expect(
    page.getByRole("button", { name: "Try connecting Gmail again" }),
  ).toBeVisible();
  await expect(
    page.getByText("It cannot read your inbox", { exact: false }).first(),
  ).toBeVisible();
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === "rm_gmail_state",
    ),
  ).toBeUndefined();
});

test("connected and reconnect states use safe metadata and offer disconnect", async ({
  page,
  context,
  scenario,
}) => {
  await context.addCookies([
    testSessionCookie(
      scenario.connected.accessToken,
      undefined,
      scenario.connected.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Gmail is connected", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("encrypted_refresh_token");
  await context.addCookies([
    testSessionCookie(
      scenario.reconnect.accessToken,
      undefined,
      scenario.reconnect.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  await expect(
    page.getByText("Your Gmail permission needs renewing", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect Gmail", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeVisible();
});

test("an expired Supabase session refreshes through the server and a forged session is signed out", async ({
  page,
  context,
  scenario,
}) => {
  await context.addCookies([
    testSessionCookie(
      scenario.owner.accessToken,
      0,
      scenario.owner.refreshToken,
    ),
  ]);
  await page.goto("/dashboard");
  await expect(
    page.getByText(`Signed in as ${scenario.owner.email}`),
  ).toBeVisible();
  await context.addCookies([
    { name: "rm_session", value: "forged", url: "http://127.0.0.1:3100" },
  ]);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("signed-in Connect Gmail exchanges PKCE, encrypts the row, then Disconnect revokes, deletes and pauses only owner schedules", async ({
  page,
  context,
  request,
  scenario,
}) => {
  const codes: string[] = [];
  const browserTokenRequests: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.searchParams.has("code"))
      codes.push(url.searchParams.get("code") ?? "");
    if (
      url.origin === fakeSupabaseUrl &&
      ["/token", "/revoke"].includes(url.pathname)
    )
      browserTokenRequests.push(url.pathname);
  });
  const secrets = [
    scenario.owner.accessToken,
    scenario.owner.refreshToken,
    scenario.gmailAccessToken,
    scenario.gmailRefreshToken,
    "fake-google-access-must-be-discarded",
    "fake-google-refresh-must-be-discarded",
  ];
  const assertNoTokens = async () => {
    const output = `${await page.content()}\n${JSON.stringify(await context.cookies())}`;
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain("encrypted_refresh_token");
  };
  const snapshot = async () => {
    const response = await request.get(
      `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}`,
    );
    expect(response.ok()).toBe(true);
    return response.json();
  };
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(
    page.getByText(`Signed in as ${scenario.owner.email}`),
  ).toBeVisible();
  await assertNoTokens();
  const before = await snapshot();
  await page
    .getByRole("button", { name: "Connect Gmail", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard\?gmail=connected$/);
  await expect(
    page.getByRole("heading", { name: "Gmail is connected", exact: true }),
  ).toBeVisible();
  await assertNoTokens();
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "rm_gmail_state",
    ),
  ).toBe(false);
  const connected = await snapshot();
  expect(connected.exchanges).toEqual([
    { scope: "https://www.googleapis.com/auth/gmail.send", pkceVerified: true },
  ]);
  const row = connected.connections.find(
    (connection: { user_id: string }) =>
      connection.user_id === scenario.owner.id,
  );
  expect(row).toMatchObject({
    user_id: scenario.owner.id,
    google_email: scenario.owner.email,
    status: "connected",
  });
  expect(JSON.stringify(row)).not.toContain(scenario.gmailRefreshToken);
  const [, iv, tag, ciphertext] = row.encrypted_refresh_token.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(testEncryptionKey, "base64"),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(scenario.owner.id));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  expect(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString(),
  ).toBe(scenario.gmailRefreshToken);
  expect(connected.schedules).toEqual(before.schedules);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?gmail=disconnected$/);
  await expect(page.getByRole("status")).toContainText(
    "All your schedules are paused",
  );
  await expect(
    page.getByRole("button", { name: "Connect Gmail", exact: true }),
  ).toBeVisible();
  await assertNoTokens();
  const disconnected = await snapshot();
  expect(disconnected.revokedTokens).toEqual([scenario.gmailRefreshToken]);
  expect(disconnected.connections).toEqual(before.connections);
  expect(disconnected.schedules).toEqual(
    before.schedules.map((schedule: { user_id: string; status: string }) =>
      schedule.user_id === scenario.owner.id
        ? { ...schedule, status: "paused" }
        : schedule,
    ),
  );
  expect(
    disconnected.schedules.filter(
      (schedule: { user_id: string }) =>
        schedule.user_id === scenario.foreignUserId,
    ),
  ).toEqual(
    before.schedules.filter(
      (schedule: { user_id: string }) =>
        schedule.user_id === scenario.foreignUserId,
    ),
  );
  expect(browserTokenRequests).toEqual([]);
  expect(codes).toHaveLength(2);
  await expect
    .poll(async () =>
      readFile(resolve(__dirname, "../test-results/web-server.log"), "utf8"),
    )
    .toContain("/api/gmail/disconnect");
  const logs = await readFile(
    resolve(__dirname, "../test-results/web-server.log"),
    "utf8",
  );
  for (const secret of [
    ...secrets,
    ...codes,
    scenario.owner.email,
    "fake-google-secret",
    testEncryptionKey,
  ])
    expect(logs).not.toContain(secret);
});

test("Gmail mutation routes reject GET and cross-origin requests", async ({
  request,
}) => {
  expect((await request.get("/api/gmail/connect")).status()).toBe(405);
  expect((await request.get("/api/gmail/disconnect")).status()).toBe(405);
  expect(
    (
      await request.post("/api/gmail/disconnect", {
        headers: { Origin: "https://attacker.test" },
      })
    ).status(),
  ).toBe(403);
  const callback = await request.get(
    "/api/gmail/callback?state=forged&code=forged",
    { maxRedirects: 0 },
  );
  expect(callback.headers().location).toBe(
    "http://127.0.0.1:3100/dashboard?auth=required",
  );
});
