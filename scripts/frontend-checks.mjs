import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const knownUnchangedModels = new Set([
  "scanner-model.spec.js",
  "hybrid-search.spec.js",
  "one-card.spec.js",
]);
const files = (await readdir("tests/ui"))
  .filter(
    (file) => file.endsWith(".spec.js") && !knownUnchangedModels.has(file),
  )
  .map((file) => "tests/ui/" + file);
function run(args) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", ...args],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
run(["test", ...files, "--workers=1"]);
run([
  "test",
  "tests/ui/discovery.spec.js",
  "tests/ui/home.spec.js",
  "tests/ui/card-page.spec.js",
  "tests/ui/scan-wheel-photo.spec.js",
  "tests/ui/backend-scanner.spec.js",
  "tests/ui/app.spec.js",
  "tests/ui/phone-review.spec.js",
  "tests/ui/card-actions.spec.js",
  "tests/ui/frontend-release.spec.js",
  "--browser=webkit",
  "--workers=1",
]);
run(["test", "--config", "tests/prototype/playwright.config.mjs"]);
