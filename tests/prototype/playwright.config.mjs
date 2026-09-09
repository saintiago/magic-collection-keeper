import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
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
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "node tests/prototype/serve.mjs",
    url: "http://127.0.0.1:3120",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
