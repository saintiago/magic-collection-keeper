import { test } from "node:test";
import assert from "node:assert/strict";
import { planRelease } from "../scripts/release-plan.mjs";

const base = {
  schema: 1,
  id: "r90-a1",
  commit: "a".repeat(40),
  api: {
    commit: "b".repeat(40),
    version: "0.1.0+deploy.80.1",
    codeSha256: "a".repeat(43) + "=",
  },
  assets: { id: "r80-a1", manifestSha256: "c".repeat(64) },
  recognition: { sourceSha256: "d".repeat(64), version: "14" },
  configSha256: "e".repeat(64),
};

test("DEPLOY-01/02 presentation-only changes reuse an independently identified backend", () => {
  const result = planRelease({
    base,
    changedPaths: [
      "public/card-actions.css",
      "public/artwork-viewer.js",
      "tests/ui/card-actions.spec.js",
      "docs/REQUIREMENTS.md",
    ],
  });
  assert.equal(result.mode, "frontend");
  assert.equal(result.baseCommit, base.commit);
  assert.notEqual(result.baseCommit, base.api.commit);
});

test("DEPLOY-02 unknown files, API callers and every infrastructure/build input force full release", () => {
  for (const path of [
    "cloud.mjs",
    "domain/tag-action.js",
    "application/routes.js",
    "public/api.js",
    "public/card-actions.js",
    "public/new-control.js",
    "public/card-presence-worker.js",
    "recognition/artifact-manifest.json",
    "package-lock.json",
    "scripts/release-plan.mjs",
    ".github/workflows/deploy.yml",
    "infra/template.json",
  ]) {
    const result = planRelease({
      base,
      changedPaths: ["public/style.css", path],
    });
    assert.equal(result.mode, "full", path);
    assert.deepEqual(result.fullInputs, [path]);
  }
});

test("DEPLOY-02 missing or corrupt published identities never use the fast path", () => {
  for (const invalid of [
    undefined,
    {},
    { ...base, schema: 2 },
    { ...base, api: {} },
    { ...base, assets: {} },
    { ...base, recognition: {} },
    { ...base, commit: "HEAD" },
  ]) {
    assert.equal(
      planRelease({ base: invalid, changedPaths: ["public/style.css"] }).mode,
      "full",
    );
  }
  for (const path of [
    "../public/style.css",
    "/public/style.css",
    "public\\style.css",
    "",
  ]) {
    assert.throws(
      () => planRelease({ base, changedPaths: [path] }),
      /repository-relative/,
    );
  }
});

test("DEPLOY-01 saved requirements and tests alone do not republish application code", () => {
  for (const changedPaths of [
    [],
    ["docs/REQUIREMENTS.md", "AGENTS.md"],
    ["tests/prototype/playwright.config.mjs"],
  ]) {
    assert.equal(planRelease({ changedPaths }).mode, "checks");
  }
});

test("DEPLOY-05 explicit frontend redeploy keeps compatibility and unknown-input guards", () => {
  assert.equal(
    planRelease({ base, changedPaths: [], redeployFrontend: true }).mode,
    "frontend",
  );
  assert.equal(
    planRelease({ changedPaths: [], redeployFrontend: true }).mode,
    "full",
  );
  assert.equal(
    planRelease({ base, changedPaths: ["cloud.mjs"], redeployFrontend: true })
      .mode,
    "full",
  );
});
