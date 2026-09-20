import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPython312 } from "./python312.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let result;
try {
  result = spawnPython312(["-m", "unittest", "discover", "-s", "tests"], {
    cwd: path.join(root, "recognition"),
    env: process.env,
    stdio: "inherit",
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
