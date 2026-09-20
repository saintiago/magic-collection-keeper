import test from "node:test";
import assert from "node:assert/strict";
import { verifyDeliveryResult } from "../scripts/verify-delivery-result.mjs";

const sha = "a".repeat(40);
const base = {
  plan: "success",
  docs: "skipped",
  frontend: "skipped",
  test: "skipped",
  deploy: "skipped",
  event: "pull_request",
  ref: "refs/pull/7/merge",
  commit: sha,
};

test("B-05 every selected PR path produces one exact-commit result", () => {
  assert.match(
    verifyDeliveryResult({ ...base, mode: "docs", docs: "success" }),
    new RegExp(sha),
  );
  assert.doesNotThrow(() =>
    verifyDeliveryResult({ ...base, mode: "checks", test: "success" }),
  );
  assert.doesNotThrow(() =>
    verifyDeliveryResult({ ...base, mode: "frontend", frontend: "success" }),
  );
  assert.doesNotThrow(() =>
    verifyDeliveryResult({ ...base, mode: "full", test: "success" }),
  );
});

test("B-05 main publication requires the selected push workflow", () => {
  const main = {
    ...base,
    mode: "full",
    event: "push",
    ref: "refs/heads/main",
    test: "success",
  };
  assert.throws(() => verifyDeliveryResult(main), /deploy must be success/);
  assert.doesNotThrow(() =>
    verifyDeliveryResult({ ...main, deploy: "success" }),
  );
});

test("B-05 missing, failed, cancelled and unexpectedly selected jobs fail closed", () => {
  for (const result of ["", "failure", "cancelled", "skipped"]) {
    assert.throws(() =>
      verifyDeliveryResult({ ...base, mode: "checks", test: result }),
    );
  }
  assert.throws(() =>
    verifyDeliveryResult({
      ...base,
      mode: "docs",
      docs: "success",
      frontend: "success",
    }),
  );
  assert.throws(() => verifyDeliveryResult({ ...base, mode: "surprise" }));
  assert.throws(() =>
    verifyDeliveryResult({
      ...base,
      mode: "docs",
      docs: "success",
      commit: "HEAD",
    }),
  );
});
