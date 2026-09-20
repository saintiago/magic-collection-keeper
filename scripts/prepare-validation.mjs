import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPython312 } from "./python312.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireSuccess(label, result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function run(command, args, label) {
  requireSuccess(
    label,
    spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" }),
  );
}

requireSuccess(
  "Python visual dependency installation",
  spawnPython312(
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      "recognition/requirements-visual.txt",
    ],
    { cwd: root, env: process.env, stdio: "inherit" },
  ),
);
requireSuccess(
  "Verified visual asset preparation",
  spawnPython312(["recognition/scripts/prepare.py", "--visual-only"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
);
run(process.execPath, ["scripts/build-name-index.mjs"], "Name-index build");
run(
  process.execPath,
  ["node_modules/playwright/cli.js", "install", "chromium"],
  "Playwright Chromium installation",
);
console.log(
  "Prepared verified model, catalog, and browser inputs for validation.",
);
