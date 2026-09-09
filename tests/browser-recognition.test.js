import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRecognition } from "../public/browser-recognition.js";
const card = {
  id: "00000000-0000-4000-8000-000000000001",
  oracle_id: "00000000-0000-4000-8000-000000000002",
  name: "Public fixture",
  finishes: ["nonfoil"],
};
const canvas = {
  width: 1,
  height: 1,
  getContext: () => ({
    getImageData: () => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray(4),
    }),
  }),
};
class WorkerStub {
  static instances = [];
  constructor() {
    WorkerStub.instances.push(this);
  }
  postMessage(message) {
    this.messages ??= [];
    this.messages.push(message);
  }
  emit(data) {
    this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("worker preparation is shared; reviewed canonical metadata is reused without selecting printing", async (t) => {
  const original = globalThis.Worker;
  globalThis.Worker = WorkerStub;
  t.after(() => {
    if (original) globalThis.Worker = original;
    else delete globalThis.Worker;
  });
  let reads = 0;
  const port = createBrowserRecognition({
    request: async () => {
      reads++;
      return { cards: [card] };
    },
  });
  const preparation = port.prepare();
  assert.equal(port.prepare(), preparation);
  const worker = WorkerStub.instances.at(-1);
  worker.emit({ type: "ready", metrics: { prepareMs: 100 } });
  await preparation;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const pending = port.recognize(canvas, { attempt });
    await tick();
    worker.emit({
      type: "result",
      result: {
        contractVersion: 1,
        attempt,
        status: "possible",
        candidates: [card],
      },
    });
    const row = await pending;
    assert.deepEqual(row.selected, card);
    assert.equal(row.suggested, true);
    assert.equal(row.measurement.cacheHits, attempt - 1);
  }
  assert.equal(reads, 1);
  port.dispose();
});
test("aborted model preparation rejects late worker replies and allows a fresh attempt", async (t) => {
  const original = globalThis.Worker;
  globalThis.Worker = WorkerStub;
  t.after(() => {
    if (original) globalThis.Worker = original;
    else delete globalThis.Worker;
  });
  const port = createBrowserRecognition({
    request: async () => ({ cards: [] }),
  });
  const controller = new AbortController();
  const pending = port.recognize(canvas, {
    attempt: 1,
    signal: controller.signal,
  });
  const old = WorkerStub.instances.at(-1);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejection;
  const next = port.recognize(canvas, { attempt: 2 });
  const worker = WorkerStub.instances.at(-1);
  old.emit({ type: "ready", metrics: { invalid: true } });
  await tick();
  assert.equal(worker.messages.length, 1);
  worker.emit({ type: "ready", metrics: { prepareMs: 1 } });
  await tick();
  worker.emit({
    type: "result",
    result: { contractVersion: 1, attempt: 2, status: "unknown" },
  });
  assert.equal((await next).selected, null);
  port.dispose();
});
test("worker errors reset model reuse and hydration retains the busy guard", async (t) => {
  const original = globalThis.Worker;
  globalThis.Worker = WorkerStub;
  t.after(() => {
    if (original) globalThis.Worker = original;
    else delete globalThis.Worker;
  });
  let finish;
  const port = createBrowserRecognition({
    request: () => new Promise((resolve) => (finish = resolve)),
  });
  const first = port.recognize(canvas, { attempt: 1 });
  const rejected = assert.rejects(first, /unavailable/);
  WorkerStub.instances.at(-1).emit({ type: "error", message: "unavailable" });
  await rejected;
  const next = port.recognize(canvas, { attempt: 2 });
  const worker = WorkerStub.instances.at(-1);
  worker.emit({ type: "ready", metrics: { prepareMs: 1 } });
  await tick();
  worker.emit({
    type: "result",
    result: {
      contractVersion: 1,
      attempt: 2,
      status: "possible",
      candidates: [card],
    },
  });
  await tick();
  await assert.rejects(port.recognize(canvas, { attempt: 3 }), /busy/);
  finish({ cards: [card] });
  assert.equal((await next).measurement.modelsReused, false);
  port.dispose();
});
