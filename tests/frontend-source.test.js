import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";

test("DEPLOY-04 source overlay contains only committed public source, including deletion semantics", async (t) => {
  const root = resolve("build");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, "source-test-"));
  t.after(async () => {
    assert.ok(resolve(cwd).startsWith(root + sep));
    await rm(cwd, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "--quiet");
  await mkdir(join(cwd, "public"));
  await writeFile(join(cwd, "public/app.js"), "export const version = 1;\n");
  await writeFile(join(cwd, "public/deleted.js"), "old");
  await writeFile(
    join(cwd, "private.txt"),
    "private fixture, must not enter public archive",
  );
  git("add", ".");
  const commit = () =>
    git(
      "-c",
      "user.name=Source test",
      "-c",
      "user.email=source-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Source fixture",
    );
  commit();
  git("rm", "public/deleted.js");
  commit();
  await writeFile(join(cwd, "public/app.js"), "UNCOMMITTED CHANGE");
  await writeFile(join(cwd, "public/config.json"), "PRIVATE GENERATED FIXTURE");
  execFileSync(
    process.env.PYTHON || "python",
    [resolve("scripts/frontend-source.py"), "source.zip"],
    { cwd },
  );
  const entries = JSON.parse(
    execFileSync(
      process.env.PYTHON || "python",
      [
        "-c",
        "import zipfile,json; z=zipfile.ZipFile('source.zip'); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))",
      ],
      { cwd, encoding: "utf8" },
    ),
  );
  assert.deepEqual(Object.keys(entries), [
    "keeper/public/app.js",
    "frontend-source-manifest.json",
  ]);
  assert.equal(entries["keeper/public/app.js"], "export const version = 1;\n");
  assert.equal(
    JSON.parse(entries["frontend-source-manifest.json"]).commit,
    git("rev-parse", "HEAD").toString().trim(),
  );
  git("add", "public/config.json");
  commit();
  assert.throws(
    () =>
      execFileSync(
        process.env.PYTHON || "python",
        [resolve("scripts/frontend-source.py"), "bad.zip"],
        { cwd, stdio: "pipe" },
      ),
    /Generated config\/vendor/,
  );
});
