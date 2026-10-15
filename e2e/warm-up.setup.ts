import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test as setup } from "@playwright/test";

// The browser tests run against `next dev`, which compiles a route the first
// time it is requested. On a slow runner that can take longer than an
// assertion's 5 second timeout, so compile every route once before any test
// starts. next.config.ts keeps compiled routes in memory for the whole run.
const appDirectory = join(__dirname, "../apps/web/app");
const placeholderId = "00000000-0000-4000-8000-000000000000";
const metadataRoutes: Record<string, string> = {
  "apple-icon.png": "apple-icon.png",
  "favicon.ico": "favicon.ico",
  "icon.svg": "icon.svg",
  "manifest.ts": "manifest.webmanifest",
  "opengraph-image.tsx": "opengraph-image",
  "robots.ts": "robots.txt",
  "sitemap.ts": "sitemap.xml",
};

function routePaths(directory: string, segments: string[] = []): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Route groups such as (app) do not appear in the URL.
      const segment = /^\(.*\)$/.test(entry.name)
        ? []
        : [/^\[.*\]$/.test(entry.name) ? placeholderId : entry.name];
      paths.push(
        ...routePaths(join(directory, entry.name), [...segments, ...segment]),
      );
    } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
      paths.push(`/${segments.join("/")}`);
    } else if (segments.length === 0 && entry.name in metadataRoutes) {
      paths.push(`/${metadataRoutes[entry.name]}`);
    }
  }
  return paths;
}

setup("compile every route before the tests run", async ({ request }) => {
  setup.setTimeout(10 * 60_000);
  const paths = routePaths(appDirectory).sort();
  expect(paths).toContain("/api/schedules/pause-all");
  expect(paths).toContain(`/schedules/${placeholderId}/edit`);
  for (const path of paths) {
    // Signed out and with a placeholder id, most routes redirect or refuse.
    // Any answer below 500 means the route compiled.
    const response = await request.get(path, {
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: 120_000,
    });
    expect(response.status(), path).toBeLessThan(500);
  }
});
