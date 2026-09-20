import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  currentSourceTreeDigest,
  digestSourceEntries,
  runtimeSourceInput,
  verifySourceReadiness,
} from "../scripts/verify-source-readiness.mjs";

test("B-09 source readiness digest is stable, byte-sensitive and scoped like the deployment guard", () => {
  const first = digestSourceEntries([
    ["server.js", Buffer.from("one")],
    ["package.json", Buffer.from("two")],
  ]);
  assert.equal(
    first,
    digestSourceEntries([
      ["package.json", Buffer.from("two")],
      ["server.js", Buffer.from("one")],
    ]),
  );
  assert.notEqual(
    first,
    digestSourceEntries([
      ["package.json", Buffer.from("changed")],
      ["server.js", Buffer.from("one")],
    ]),
  );
  assert.equal(runtimeSourceInput("docs/SPEC.md"), false);
  assert.equal(runtimeSourceInput("tests/release-plan.test.js"), false);
  assert.equal(runtimeSourceInput("public/app.js"), false);
  assert.equal(runtimeSourceInput("scripts/release-plan.mjs"), true);
  assert.match(currentSourceTreeDigest(), /^[a-f0-9]{64}$/);
  assert.equal(verifySourceReadiness(first, first), first);
  assert.throws(() => verifySourceReadiness("", first), /digest is required/);
  assert.throws(() => verifySourceReadiness("a".repeat(64), first), /differs/);
});

test("B-09 untrusted PR validation uses no secrets while trusted main keeps the live guard", () => {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const testJob = /^  test:[\s\S]*?(?=^  deploy:)/m.exec(workflow)?.[0] ?? "";
  const deployJob =
    /^  deploy:[\s\S]*?(?=^  result:)/m.exec(workflow)?.[0] ?? "";
  assert.notEqual(testJob, "");
  assert.notEqual(deployJob, "");
  assert.match(testJob, /node scripts\/verify-source-readiness\.mjs/);
  assert.doesNotMatch(testJob, /secrets\./);
  assert.doesNotMatch(testJob, /pull_request_target/);
  assert.match(deployJob, /KEEPER_TEST_PASSWORD: \$\{\{ secrets\./);
  assert.match(deployJob, /verify-corresponding-source\.py/);
});
