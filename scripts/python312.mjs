import { spawnSync } from "node:child_process";

export const WINDOWS_PYTHON312_INSTALL_COMMAND =
  "winget install --exact --id Python.Python.3.12 --source winget --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity";

export function python312MissingMessage({
  platform = process.platform,
  configuredPython = process.env.KEEPER_PYTHON,
} = {}) {
  if (configuredPython) {
    return "KEEPER_PYTHON did not resolve to Python 3.12. Set it to a Python 3.12 executable and retry.";
  }
  if (platform === "win32") {
    return `Python 3.12 was not found. Install the official Python Software Foundation package, then retry: ${WINDOWS_PYTHON312_INSTALL_COMMAND}. Alternatively, set KEEPER_PYTHON to a Python 3.12 executable.`;
  }
  return "Python 3.12 was not found. Install Python 3.12 with the platform's supported package manager or set KEEPER_PYTHON to its executable.";
}

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
    throw Error(python312MissingMessage());
  }
  return selected;
}

export function spawnPython312(args, options = {}) {
  const [executable, prefix] = selectPython312();
  return spawnSync(executable, [...prefix, ...args], options);
}
