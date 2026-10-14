import { defineConfig, devices } from "@playwright/test";
import { fakeSupabaseUrl, testEncryptionKey } from "./fixtures/auth";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "node fixtures/supabase.mjs",
      url: `${fakeSupabaseUrl}/health`,
      reuseExistingServer: false,
    },
    {
      command: "node fixtures/web-server.mjs",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        APP_URL: "http://127.0.0.1:3100",
        SUPABASE_URL: fakeSupabaseUrl,
        SUPABASE_PUBLISHABLE_KEY: "fake-publishable-key",
        SUPABASE_SECRET_KEY: "fake-secret-key",
        GOOGLE_CLIENT_ID: "fake-google-client",
        GOOGLE_CLIENT_SECRET: "fake-google-secret",
        TOKEN_ENCRYPTION_KEY: testEncryptionKey,
        ADMIN_EMAILS: "admin@example.test",
        RECURMAIL_TEST_OAUTH_ORIGIN: fakeSupabaseUrl,
      },
    },
  ],
});
