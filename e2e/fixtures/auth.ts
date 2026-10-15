import { createCipheriv, randomBytes } from "node:crypto";
import { test as base, expect } from "@playwright/test";

// Explicitly synthetic test key and credentials, never deployment credentials.
export const testEncryptionKey = Buffer.alloc(32, 7).toString("base64");
export const fakeSupabaseUrl = "http://127.0.0.1:3101";

export function testSessionCookie(
  accessToken: string,
  expiresAt = Date.now() + 3600000,
  refreshToken = "e2e-session-refresh",
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(testEncryptionKey, "base64"),
    iv,
  );
  cipher.setAAD(Buffer.from("session"));
  const plaintext = JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    name: "rm_session",
    value: [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    url: "http://127.0.0.1:3100",
    httpOnly: true,
    sameSite: "Lax" as const,
  };
}

interface FakeUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}
interface Scenario {
  id: string;
  owner: FakeUser;
  connected: FakeUser;
  reconnect: FakeUser;
  foreignUserId: string;
  gmailAccessToken: string;
  gmailRefreshToken: string;
}

export const test = base.extend<{ scenario: Scenario }>({
  scenario: async ({ request, context }, use) => {
    const response = await request.post(`${fakeSupabaseUrl}/__test/scenarios`);
    expect(response.ok()).toBe(true);
    const scenario: Scenario = await response.json();
    await context.addCookies([
      {
        name: "fake_scenario",
        value: scenario.id,
        url: fakeSupabaseUrl,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    try {
      await use(scenario);
    } finally {
      await request.delete(
        `${fakeSupabaseUrl}/__test/scenarios/${scenario.id}`,
      );
    }
  },
});
