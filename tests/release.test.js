import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import {
  deploymentRelease,
  assertNewerRelease,
  packageWebsite,
} from "../scripts/release.mjs";
const env = {
  GITHUB_RUN_NUMBER: "19",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "1234",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "example/keeper",
};
test("UC-16 deployment identity increments on attempts and refuses published version regression", () => {
  const first = deploymentRelease(
    "0.1.0",
    env,
    new Date("2026-09-08T08:00:00Z"),
  );
  const retry = deploymentRelease("0.1.0", { ...env, GITHUB_RUN_ATTEMPT: "2" });
  const next = deploymentRelease("0.1.0", { ...env, GITHUB_RUN_NUMBER: "20" });
  assert.equal(first.version, "0.1.0+deploy.19.1");
  assert.equal(retry.version, "0.1.0+deploy.19.2");
  const index = '<meta name="keeper-release" content="r19-a1">';
  assert.throws(() => assertNewerRelease(first, index), /reuse or regress/);
  assert.doesNotThrow(() => assertNewerRelease(retry, index));
  assert.doesNotThrow(() => assertNewerRelease(next, index));
  assert.throws(() =>
    assertNewerRelease(first, '<meta name="keeper-release" content="r20-a1">'),
  );
  assert.throws(() =>
    deploymentRelease("0.1.0", { ...env, GITHUB_RUN_ATTEMPT: "0" }),
  );
  assert.throws(() =>
    deploymentRelease("0.1.0", { ...env, GITHUB_SHA: "short" }),
  );
});
test("UC-16 publishing new HTML retains old asset and metadata identity", async (t) => {
  const root = resolve("build");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "release-test-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, "source"),
    destination = join(directory, "site");
  await mkdir(source);
  await writeFile(
    join(source, "index.html"),
    '<head><link href="/style.css"><script src="/app.js"></script></head>',
  );
  await writeFile(
    join(source, "app.js"),
    'import {release} from "./release.js";',
  );
  await writeFile(join(source, "style.css"), "body{}");
  await mkdir(join(source, "vendor/ort"), { recursive: true });
  await writeFile(join(source, "vendor/ocr.js"), "retired runtime");
  await writeFile(join(source, "vendor/ort/ort.webgpu.min.mjs"), "retired GPU");
  await writeFile(
    join(source, "vendor/ort/ort.wasm.min.mjs"),
    "selected runtime",
  );
  const first = deploymentRelease("0.1.0", env),
    second = deploymentRelease("0.1.0", { ...env, GITHUB_RUN_NUMBER: "20" });
  await packageWebsite({ source, destination, release: first });
  await assert.rejects(
    readFile(join(destination, "releases/r19-a1/vendor/ocr.js")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(
      join(destination, "releases/r19-a1/vendor/ort/ort.webgpu.min.mjs"),
    ),
    { code: "ENOENT" },
  );
  assert.equal(
    await readFile(
      join(destination, "releases/r19-a1/vendor/ort/ort.wasm.min.mjs"),
      "utf8",
    ),
    "selected runtime",
  );
  const oldIndex = await readFile(join(destination, "index.html"), "utf8");
  await packageWebsite({ source, destination, release: second });
  assert.match(oldIndex, /src="\/releases\/r19-a1\/app.js"/);
  assert.match(
    await readFile(join(destination, "index.html"), "utf8"),
    /r20-a1\/style.css/,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(destination, "releases/r19-a1/version.json")),
    ),
    first,
  );
  const old = await import(
    new URL(
      "../" +
        join(
          "build",
          directory.slice(root.length + 1),
          "site/releases/r19-a1/release.js",
        ).replaceAll("\\", "/"),
      import.meta.url,
    )
  );
  assert.equal(old.release.version, first.version);
});
