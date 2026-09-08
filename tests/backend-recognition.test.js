import test from "node:test";
import assert from "node:assert/strict";
import { createBackendRecognition } from "../public/backend-recognition.js";
const canvas = {
  width: 200,
  height: 300,
  toBlob: (cb) => cb(new Blob(["fixture"], { type: "image/jpeg" })),
};
test("backend browser adapter rejects canceled, late and unapproved acceptance responses", async () => {
  let finish;
  const port = createBackendRecognition({
    request: () => new Promise((r) => (finish = r)),
  });
  const controller = new AbortController();
  const pending = port.recognize(canvas, {
    signal: controller.signal,
    attempt: 1,
  });
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(port.recognize(canvas, { attempt: 2 }), /busy/);
  controller.abort();
  finish({ attempt: 1, status: "possible", candidates: [] });
  await assert.rejects(pending, { name: "AbortError" });
  const unsafe = createBackendRecognition({
    request: async () => ({ attempt: 2, status: "accepted" }),
  });
  await assert.rejects(
    unsafe.recognize(canvas, { attempt: 2 }),
    /not approved/,
  );
  const wrong = createBackendRecognition({
    request: async () => ({ attempt: 3, status: "possible" }),
  });
  await assert.rejects(wrong.recognize(canvas, { attempt: 2 }), /not approved/);
});
test("possible recognition is never an automatic selected printing", async () => {
  const port = createBackendRecognition({
    request: async () => ({ attempt: 1, status: "possible", candidates: [] }),
  });
  assert.deepEqual(await port.recognize(canvas, { attempt: 1 }), {
    status: "possible",
    candidates: [],
    selected: null,
  });
});
