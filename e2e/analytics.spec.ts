import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { appOrigin, fakeSupabaseUrl, test } from "./fixtures/auth";

interface StoredEvent {
  event: string;
  anonymous_id: string | null;
  session_id: string | null;
  user_id: string | null;
  user_email: string | null;
  path: string | null;
  source: string | null;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  device: string | null;
  ip_address: string | null;
  user_agent: string | null;
  is_bot: boolean;
  properties: Record<string, unknown>;
}
interface Stored {
  events: StoredEvent[];
  attribution: Record<string, unknown>[];
}

async function useFakeGoogleSignin(page: Page) {
  await page.route("**/auth/signin", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const headers = response.headers();
    const googleUrl = new URL(headers.location);
    headers.location = `${fakeSupabaseUrl}${googleUrl.pathname}${googleUrl.search}`;
    await route.fulfill({ response, headers });
  });
}

/** Everything the fake database holds for one browser or one user. */
async function stored(
  request: APIRequestContext,
  query: string,
): Promise<Stored> {
  const response = await request.get(
    `${fakeSupabaseUrl}/__test/analytics?${query}`,
  );
  expect(response.ok()).toBe(true);
  return response.json();
}

/** Waits for an event of this name to be stored and returns it. */
async function storedEvent(
  request: APIRequestContext,
  query: string,
  name: string,
  match: (event: StoredEvent) => boolean = () => true,
): Promise<StoredEvent> {
  let found: StoredEvent | undefined;
  await expect
    .poll(async () => {
      found = (await stored(request, query)).events.find(
        (event) => event.event === name && match(event),
      );
      return found?.event;
    })
    .toBe(name);
  if (!found) throw new Error(`${name} was never recorded`);
  return found;
}

/** The ids and first touch the page keeps in local storage. */
function browserState(page: Page) {
  return page.evaluate(() => {
    const read = (key: string) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    };
    return {
      anonymousId: read("rm_aid") as string | null,
      firstTouch: read("rm_first_touch") as Record<string, unknown> | null,
      lastTouch: read("rm_last_touch") as Record<string, unknown> | null,
    };
  });
}

function decodeCookie(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

/** Every body the browser posted to /api/events. */
function collectEventBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname === "/api/events")
      bodies.push(sent.postData() ?? "");
  });
  return bodies;
}

test("a campaign visit stores the first touch in the browser and reports page views, reading depth and FAQ opens with its source", async ({
  page,
  context,
  request,
}) => {
  const bodies = collectEventBodies(page);
  await page.goto("/?utm_source=reddit&utm_medium=social&utm_campaign=launch");
  await expect
    .poll(async () => (await browserState(page)).anonymousId)
    .toMatch(/^[0-9a-f-]{36}$/);
  const state = await browserState(page);
  const anonymousId = state.anonymousId ?? "";
  expect(state.firstTouch).toMatchObject({
    source: "reddit",
    utm_source: "reddit",
    utm_medium: "social",
    utm_campaign: "launch",
    referrer_host: null,
    landing_path: "/",
  });
  expect(Date.parse(String(state.firstTouch?.first_seen_at))).not.toBeNaN();
  expect(state.lastTouch).toMatchObject({ source: "reddit" });

  // The ids are mirrored to first-party cookies the server can read.
  const cookies = await context.cookies(appOrigin);
  const aidCookie = cookies.find((cookie) => cookie.name === "rm_aid");
  expect(aidCookie).toMatchObject({
    value: anonymousId,
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
  });
  expect((aidCookie?.expires ?? 0) * 1000).toBeGreaterThan(
    Date.now() + 360 * 86400000,
  );
  const ftCookie = cookies.find((cookie) => cookie.name === "rm_ft");
  expect(decodeCookie(ftCookie?.value ?? "")).toEqual(state.firstTouch);
  expect(cookies.find((cookie) => cookie.name === "rm_sid")?.value).toMatch(
    /^[0-9a-f-]{36}$/,
  );

  const view = await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "page_view",
  );
  expect(view).toMatchObject({
    anonymous_id: anonymousId,
    user_id: null,
    user_email: null,
    path: "/",
    source: "reddit",
    utm_source: "reddit",
    utm_medium: "social",
    utm_campaign: "launch",
    device: "desktop",
    ip_address: "127.0.0.1",
    is_bot: false,
  });
  expect(view.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(view.user_agent).toContain("Chrome");

  // Reading to the bottom and opening a question are reported once each.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "scroll_depth",
    (event) => event.properties.depth === 100,
  );
  await page.locator("#faq summary").nth(1).click();
  await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "faq_opened",
    (event) => event.properties.question === "2",
  );

  // A later visit with no campaign keeps the original first touch.
  await page.goto("/guides/recurring-email-gmail");
  await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "page_view",
    (event) => event.path === "/guides/recurring-email-gmail",
  );
  const later = await browserState(page);
  expect(later.anonymousId).toBe(anonymousId);
  expect(later.firstTouch).toEqual(state.firstTouch);
  expect(
    (await context.cookies(appOrigin)).find((cookie) => cookie.name === "rm_ft")
      ?.value,
  ).toBe(ftCookie?.value);

  // Paths never carry a query string; only the utm fields travel.
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    const payload = JSON.parse(body) as { path: string };
    expect(payload.path).not.toContain("?");
    expect(body).not.toContain("launch&");
  }
});

test("the header call to action reports a click and a sign-up start, and signing up records the sign-up with its reddit attribution", async ({
  page,
  request,
  scenario,
}) => {
  await useFakeGoogleSignin(page);
  const bodies = collectEventBodies(page);
  const codes: string[] = [];
  page.on("request", (sent) => {
    const code = new URL(sent.url()).searchParams.get("code");
    if (code) codes.push(code);
  });
  await page.goto("/?utm_source=reddit&utm_medium=social");
  await expect
    .poll(async () => (await browserState(page)).anonymousId)
    .toMatch(/^[0-9a-f-]{36}$/);
  const anonymousId = (await browserState(page)).anonymousId ?? "";
  await storedEvent(request, `anonymous_id=${anonymousId}`, "page_view");

  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Create free account", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByText(`Signed in as ${scenario.owner.email}`),
  ).toBeVisible();

  const click = await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "cta_click",
  );
  expect(click.properties).toEqual({
    location: "header",
    label: "create_free_account",
  });
  const started = await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "signup_started",
  );
  expect(started.properties).toEqual({
    location: "header",
    label: "create_free_account",
  });

  const signup = await storedEvent(
    request,
    `user_id=${scenario.owner.id}`,
    "signup_completed",
  );
  expect(signup).toMatchObject({
    anonymous_id: anonymousId,
    user_id: scenario.owner.id,
    user_email: scenario.owner.email,
    ip_address: "127.0.0.1",
    is_bot: false,
  });
  expect(signup.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(signup.user_agent).toContain("Chrome");
  const { attribution } = await stored(request, `user_id=${scenario.owner.id}`);
  expect(attribution).toHaveLength(1);
  expect(attribution[0]).toMatchObject({
    user_id: scenario.owner.id,
    anonymous_id: anonymousId,
    user_email: scenario.owner.email,
    signup_ip: "127.0.0.1",
    first_source: "reddit",
    first_utm_source: "reddit",
    first_utm_medium: "social",
    first_referrer_host: null,
    first_landing_path: "/",
  });
  expect(String(attribution[0].signup_user_agent)).toContain("Chrome");

  // Signing out and back in is a sign-in, not a second sign-up.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${appOrigin}/`);
  // The e2e session token is not a JWT, so the sign-out carries the browser id only.
  await storedEvent(request, `anonymous_id=${anonymousId}`, "signed_out");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Sign in with Google" }).click();
  await expect(
    page.getByText(`Signed in as ${scenario.owner.email}`),
  ).toBeVisible();
  await storedEvent(request, `user_id=${scenario.owner.id}`, "login_completed");
  const user = await stored(request, `user_id=${scenario.owner.id}`);
  expect(
    user.events.filter((event) => event.event === "signup_completed"),
  ).toHaveLength(1);
  expect(user.attribution).toHaveLength(1);
  // The dashboard's sign-in link is a returning user's, not a sign-up start.
  const signIn = await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "cta_click",
    (event) => event.properties.location === "dashboard",
  );
  expect(signIn.properties).toEqual({
    location: "dashboard",
    label: "sign_in_with_google",
    intent: "login",
  });
  expect(
    (await stored(request, `anonymous_id=${anonymousId}`)).events.filter(
      (event) => event.event === "signup_started",
    ),
  ).toHaveLength(1);

  // Nothing the browser sent carried an OAuth code or the user's address.
  expect(codes.length).toBeGreaterThan(0);
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    for (const code of codes) expect(body).not.toContain(code);
    expect(body).not.toContain(scenario.owner.email);
    expect(body).not.toContain("fake-google");
  }
  const browserRows = (
    await stored(request, `anonymous_id=${anonymousId}`)
  ).events.filter((event) => event.user_id === null);
  for (const code of codes)
    expect(JSON.stringify(browserRows)).not.toContain(code);
});

test("a browser that blocks local storage keeps one id across its events and pages", async ({
  page,
  context,
  request,
}) => {
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => null;
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
  });
  const bodies = collectEventBodies(page);
  await page.goto("/");
  await expect.poll(() => bodies.length).toBeGreaterThan(0);
  const anonymousId = (await context.cookies(appOrigin)).find(
    (cookie) => cookie.name === "rm_aid",
  )?.value;
  expect(anonymousId).toMatch(/^[0-9a-f-]{36}$/);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "scroll_depth",
    (event) => event.properties.depth === 100,
  );
  await page.goto("/guides/recurring-email-gmail");
  await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "page_view",
    (event) => event.path === "/guides/recurring-email-gmail",
  );
  const ids = new Set(
    bodies.map(
      (body) => (JSON.parse(body) as { anonymous_id: string }).anonymous_id,
    ),
  );
  expect([...ids]).toEqual([anonymousId]);
});

test("the events route accepts only our own pages and keeps crawler traffic flagged", async ({
  request,
}) => {
  const anonymousId = "a0000000-0000-4000-8000-00000000e2e1";
  const event = {
    event: "page_view",
    anonymous_id: anonymousId,
    path: "/",
    device: "desktop",
    properties: {},
  };
  expect(
    (
      await request.post("/api/events", {
        headers: { Origin: "https://attacker.test" },
        data: event,
      })
    ).status(),
  ).toBe(403);
  expect((await request.get("/api/events")).status()).toBe(405);
  expect(
    (
      await request.post("/api/events", {
        headers: { Origin: appOrigin },
        data: { ...event, event: "signup_completed" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/events", {
        headers: { Origin: appOrigin, "User-Agent": "curl/8.4.0" },
        data: event,
      })
    ).status(),
  ).toBe(204);
  const crawler = await storedEvent(
    request,
    `anonymous_id=${anonymousId}`,
    "page_view",
  );
  expect(crawler).toMatchObject({ is_bot: true, user_agent: "curl/8.4.0" });
});
