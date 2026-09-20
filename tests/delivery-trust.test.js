import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("B-09 validates proposed work offline while trusted main keeps the live source guard", () => {
  const workflow = readFileSync(".github/workflows/deploy.yml", "utf8");
  const testJob = /^  test:[\s\S]*?(?=^  deploy:)/m.exec(workflow)?.[0] ?? "";
  const deployJob =
    /^  deploy:[\s\S]*?(?=^  result:)/m.exec(workflow)?.[0] ?? "";

  assert.notEqual(testJob, "");
  assert.notEqual(deployJob, "");
  assert.match(testJob, /npm test/);
  assert.match(
    testJob,
    /python recognition\/scripts\/prepare\.py --visual-only/,
  );
  assert.match(testJob, /npm run build/);
  assert.match(testJob, /npm run test:ui/);
  assert.doesNotMatch(testJob, /secrets\./);
  assert.doesNotMatch(testJob, /RECOGNITION_SOURCE_TREE_SHA256/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(deployJob, /KEEPER_TEST_PASSWORD: \$\{\{ secrets\./);
  assert.match(deployJob, /verify-corresponding-source\.py/);
});
