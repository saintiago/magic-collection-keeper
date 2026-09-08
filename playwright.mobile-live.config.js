import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/mobile-live",
  timeout: 120000,
  use: {
    ...devices["iPhone 13"],
    browserName: "webkit",
    baseURL: process.env.LIVE_URL,
    headless: true,
  },
  reporter: "list",
  workers: 1,
});
