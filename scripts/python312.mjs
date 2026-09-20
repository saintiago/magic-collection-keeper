import { spawnSync } from "node:child_process";

export function selectPython312() {
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
  const selected = candidates.find(([candidate, prefix]) => {
    const probe = spawnSync(candidate, [...prefix, "--version"], {
      encoding: "utf8",
    });
    return (
      probe.status === 0 &&
      /Python 3\.12(?:\.|\s|$)/.test(`${probe.stdout}${probe.stderr}`)
    );
  });
  if (!selected) {
    throw Error(
      "Python 3.12 was not found. Put it on PATH or set KEEPER_PYTHON to its executable.",
    );
  }
  return selected;
}

export function spawnPython312(args, options = {}) {
  const [executable, prefix] = selectPython312();
  return spawnSync(executable, [...prefix, ...args], options);
}
