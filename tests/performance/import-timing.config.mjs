import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".",
  testMatch: "import-timing.spec.js",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3100", headless: true },
  webServer: {
    command: "node server.js",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:3100",
    env: { PORT: "3100", DB_PATH: ":memory:" },
    reuseExistingServer: false,
  },
  reporter: "list",
});
