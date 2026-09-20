import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = process.env.KEEPER_PYTHON
  ? [[process.env.KEEPER_PYTHON, []]]
  : process.platform === "win32"
    ? [
        ["py", ["-3.12"]],
        ["python", []],
      ]
    : [
        ["python", []],
        ["python3", []],
      ];
const selected = candidates.find(([candidate, args]) => {
  const probe = spawnSync(candidate, [...args, "--version"], {
    encoding: "utf8",
  });
  return (
    probe.status === 0 &&
    /Python 3\.12(?:\.|\s|$)/.test(`${probe.stdout}${probe.stderr}`)
  );
});

if (!selected) {
  console.error(
    "Python 3.12 was not found. Put it on PATH or set KEEPER_PYTHON to its executable.",
  );
  process.exit(1);
}

const [executable, prefix] = selected;
const result = spawnSync(
  executable,
  [...prefix, "-m", "unittest", "discover", "-s", "tests"],
  {
    cwd: path.join(root, "recognition"),
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
