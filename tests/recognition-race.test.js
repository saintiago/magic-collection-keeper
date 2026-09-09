import { test } from "node:test";
import assert from "node:assert/strict";
import { raceReadings, mergeReadings } from "../public/recognition-race.js";
const defer = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reading = (id, evidence = {}) => ({
  status: "possible",
  suggested: true,
  name: id,
  selected: { id, oracle_id: id, name: id },
  candidates: [{ id, oracle_id: id, name: id }],
  measurement: { evidence },
});
test("UC-SCAN-RACE fast validated local reading avoids paid work; unknown triggers one remote read", async () => {
  let calls = 0;
  const result = await raceReadings({
    local: async () => reading("a"),
    remote: async () => {
      calls++;
      return reading("b");
    },
    delayMs: 100,
  });
  assert.equal(result.selected.id, "a");
  assert.equal(calls, 0);
  const rescued = await raceReadings({
    local: async () => ({ status: "unknown" }),
    remote: async () => {
      calls++;
      return reading("b");
    },
    delayMs: 100,
  });
  assert.equal(rescued.selected.id, "b");
  assert.equal(calls, 1);
});
test("UC-SCAN-RACE first validated result returns immediately; late title evidence updates the same candidates without comparing scores", async () => {
  const local = defer(),
    remote = defer(),
    updates = [];
  const task = raceReadings({
    local: () => local.promise,
    remote: () => remote.promise,
    delayMs: 0,
    onUpdate: (result) => updates.push(result),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  local.resolve(reading("a", { topScore: 0.99 }));
  const first = await task;
  assert.equal(first.selected.id, "a");
  assert.equal(first.provisional, true);
  remote.resolve(
    reading("b", {
      identityTitleCorroborated: true,
      titleEvidenceProvider: "vision_language",
      topScore: 0.6,
    }),
  );
  await tick();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].selected.id, "b");
  assert.equal(updates[0].disagreement, true);
  assert.equal(updates[0].candidates.length, 2);
});
test("UC-SCAN-RACE canceled late verification and unknown cannot replace valid selections", async () => {
  const remote = defer(),
    local = defer(),
    controller = new AbortController(),
    updates = [];
  const task = raceReadings({
    local: () => local.promise,
    remote: () => remote.promise,
    delayMs: 0,
    signal: controller.signal,
    onUpdate: (r) => updates.push(r),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  local.resolve(reading("a"));
  await task;
  controller.abort();
  remote.resolve(reading("b"));
  await tick();
  assert.equal(updates.length, 0);
  const merged = mergeReadings([
    { result: reading("a"), provider: "browser-onnx" },
    { result: { status: "unknown" }, provider: "lambda" },
  ]);
  assert.equal(merged.selected.id, "a");
  assert.equal(merged.disagreement, false);
});
