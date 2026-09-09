import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  workers: 2,
  use: { baseURL: "http://127.0.0.1:3120", headless: true },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "node tests/prototype/serve.mjs",
    url: "http://127.0.0.1:3120",
    reuseExistingServer: true,
  },
  reporter: "list",
});
