import test from "node:test";
import assert from "node:assert/strict";
import { createIndependentRecognition } from "../public/independent-recognition.js";
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const reading = (id, evidence = {}) => ({
  status: "possible",
  suggested: true,
  selected: { id, oracle_id: id, name: id },
  candidates: [{ id, oracle_id: id, name: id }],
  measurement: { evidence },
});
const tick = () => new Promise((r) => setImmediate(r));
test("UC-INDEPENDENT first model proposal and later primary updates preserve three sources and evidence priority", async () => {
  const a = defer(),
    b = defer(),
    updates = [];
  let updatePrimary;
  const adapter = createIndependentRecognition({
    primary: {
      prepare: async () => {},
      dispose() {},
      recognize: async (c, o) => {
        updatePrimary = o.onUpdate;
        return a.promise;
      },
    },
    independent: { recognize: () => b.promise },
  });
  const task = adapter.recognize(
    {},
    { attempt: 1, onUpdate: (r) => updates.push(r) },
  );
  b.resolve(
    reading("model", {
      independentIdentity: true,
      identityBasis: "visible_title",
    }),
  );
  assert.equal((await task).selected.id, "model");
  a.resolve(reading("visual"));
  await tick();
  assert.equal(updates.at(-1).selected.id, "model");
  const reviewed = reading("ocr", { identityTitleCorroborated: true });
  reviewed.candidates.push(reading("visual").selected);
  reviewed.recognition = [
    { printing_id: "ocr", provider: "lambda", evidence: "visible-title-ocr" },
    { printing_id: "visual", provider: "browser-onnx", evidence: "visual" },
  ];
  updatePrimary(reviewed);
  assert.equal(updates.at(-1).selected.id, "ocr");
  assert.equal(updates.at(-1).candidates.length, 3);
  assert.equal(updates.at(-1).recognition.length, 3);
  assert.equal(updates.at(-1).disagreement, true);
  // An inner browser/backend disagreement survives agreement between the
  // selected primary identity and the independent model.
  reviewed.selected = reading("model").selected;
  reviewed.candidates = [reviewed.selected, reading("visual").selected];
  updatePrimary(reviewed);
  assert.equal(updates.at(-1).disagreement, true);
  adapter.dispose();
  const count = updates.length;
  updatePrimary(reading("late"));
  assert.equal(updates.length, count);
});
test("UC-INDEPENDENT at most one model request in flight and bounded session budget; cancellation rejects late result", async () => {
  const held = defer();
  let calls = 0;
  const adapter = createIndependentRecognition({
    maximumCalls: 1,
    primary: {
      prepare: async () => {},
      dispose() {},
      recognize: async () => reading("a"),
    },
    independent: {
      recognize: () => {
        calls++;
        return held.promise;
      },
    },
  });
  await adapter.recognize({}, { attempt: 1 });
  await adapter.recognize({}, { attempt: 2 });
  assert.equal(calls, 1);
  held.resolve(reading("model", { independentIdentity: true }));
  await tick();
  await adapter.recognize({}, { attempt: 3 });
  assert.equal(calls, 1);
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    adapter.recognize({}, { attempt: 4, signal: cancellation.signal }),
    { name: "AbortError" },
  );
});
