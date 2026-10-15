import { defineConfig, devices } from "@playwright/test";
import {
  appOrigin,
  fakePort,
  fakeSupabaseUrl,
  testEncryptionKey,
  webPort,
} from "./fixtures/auth";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: appOrigin,
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
      env: {
        RECURMAIL_E2E_WEB_PORT: webPort,
        RECURMAIL_E2E_FAKE_PORT: fakePort,
      },
    },
    {
      command: "node fixtures/web-server.mjs",
      url: appOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        RECURMAIL_E2E_WEB_PORT: webPort,
        APP_URL: appOrigin,
        SUPABASE_URL: fakeSupabaseUrl,
        SUPABASE_PUBLISHABLE_KEY: "fake-publishable-key",
        SUPABASE_SECRET_KEY: "fake-secret-key",
        GOOGLE_CLIENT_ID: "fake-google-client",
        GOOGLE_CLIENT_SECRET: "fake-google-secret",
        TOKEN_ENCRYPTION_KEY: testEncryptionKey,
        ADMIN_EMAILS: "admin@example.test",
        RECURMAIL_TEST_OAUTH_ORIGIN: fakeSupabaseUrl,
        RECURMAIL_TEST_GMAIL_ORIGIN: fakeSupabaseUrl,
      },
    },
  ],
});
