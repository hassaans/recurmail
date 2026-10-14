import { defineConfig, devices } from "@playwright/test";
import { fakeSupabaseUrl, testEncryptionKey } from "./fixtures/auth";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
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
        NEXT_PUBLIC_SUPABASE_URL: fakeSupabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
        GOOGLE_CLIENT_ID: "fake-google-client",
        GOOGLE_CLIENT_SECRET: "fake-google-secret",
        TOKEN_ENCRYPTION_KEY: testEncryptionKey,
        ADMIN_EMAILS: "admin@example.test",
        RECURMAIL_TEST_OAUTH_ORIGIN: fakeSupabaseUrl,
      },
    },
  ],
});
