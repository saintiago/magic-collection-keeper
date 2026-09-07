import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  use: { baseURL: "http://127.0.0.1:3100", headless: true },
  webServer: {
    command: "node server.js",
    url: "http://127.0.0.1:3100",
    env: { PORT: "3100", DB_PATH: ":memory:" },
    reuseExistingServer: false,
  },
  reporter: "list",
});
