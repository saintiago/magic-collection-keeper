import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/live",
  timeout: 90000,
  use: { baseURL: process.env.LIVE_URL, headless: true },
  reporter: "list",
  workers: 1,
});
