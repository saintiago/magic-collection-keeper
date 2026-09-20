import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WINDOWS_PYTHON312_INSTALL_COMMAND,
  python312MissingMessage,
} from "../scripts/python312.mjs";

test("B-04 missing Python on Windows reports the reproducible official install", () => {
  const message = python312MissingMessage({
    platform: "win32",
    configuredPython: "",
  });

  assert.match(message, /official Python Software Foundation package/);
  assert.ok(message.includes(WINDOWS_PYTHON312_INSTALL_COMMAND));
  assert.match(message, /KEEPER_PYTHON/);
  assert.match(WINDOWS_PYTHON312_INSTALL_COMMAND, /Python\.Python\.3\.12/);
  assert.match(WINDOWS_PYTHON312_INSTALL_COMMAND, /--scope user/);
  assert.match(WINDOWS_PYTHON312_INSTALL_COMMAND, /--disable-interactivity/);
});

test("B-04 an invalid explicit Python override reports the override", () => {
  const message = python312MissingMessage({
    platform: "win32",
    configuredPython: "C:\\invalid\\python.exe",
  });

  assert.match(message, /KEEPER_PYTHON did not resolve to Python 3\.12/);
  assert.doesNotMatch(message, /winget/);
});

test("B-04 non-Windows hosts receive a package-manager diagnostic", () => {
  const message = python312MissingMessage({
    platform: "linux",
    configuredPython: "",
  });

  assert.match(message, /supported package manager/);
  assert.match(message, /KEEPER_PYTHON/);
});
