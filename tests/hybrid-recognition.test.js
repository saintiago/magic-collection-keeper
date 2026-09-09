import test from "node:test";
import assert from "node:assert/strict";
import { createHybridRecognition } from "../public/hybrid-recognition.js";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = {
  status: "possible",
  candidates: [{ id: "public" }],
  selected: { id: "unapproved" },
};
function port(kind, ready = Promise.resolve()) {
  return {
    kind,
    calls: 0,
    prepares: 0,
    prepare() {
      this.prepares++;
      return ready;
    },
    async recognize() {
      this.calls++;
      return row;
    },
    dispose() {
      this.disposed = true;
    },
  };
}
test("cached local preparation avoids cloud warm calls and every result still requires review", async () => {
  const local = port("local"),
    cloud = port("cloud");
  const hybrid = createHybridRecognition({ local, cloud, prepareDelayMs: 0 });
  await hybrid.prepare();
  await tick();
  const result = await hybrid.recognize({}, { attempt: 1 });
  assert.equal(result.selected, null);
  assert.equal(result.measurement.provider, "local");
  assert.equal(cloud.prepares, 0);
  hybrid.dispose();
});
test("cloud serves during the first download; later cards switch to ready local models without repeated warm calls", async () => {
  const loading = deferred(),
    local = port("local", loading.promise),
    cloud = port("cloud");
  const hybrid = createHybridRecognition({ local, cloud, prepareDelayMs: 0 });
  const first = await hybrid.recognize({}, { attempt: 1 });
  assert.equal(first.measurement.provider, "cloud");
  loading.resolve();
  await tick();
  const next = await hybrid.recognize({}, { attempt: 2 });
  assert.equal(next.measurement.provider, "local");
  assert.equal(cloud.prepares, 1);
  hybrid.dispose();
});
test("closing a preparing session cancels reads and never starts a delayed cloud warm call", async () => {
  const loading = deferred(),
    local = port("local", loading.promise),
    cloud = port("cloud");
  const hybrid = createHybridRecognition({
    local,
    cloud,
    prepareDelayMs: 1000,
  });
  const controller = new AbortController();
  const pending = hybrid.recognize(
    {},
    { attempt: 1, signal: controller.signal },
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  hybrid.dispose();
  await rejected;
  loading.resolve();
  await tick();
  assert.equal(cloud.prepares, 0);
  assert.equal(local.calls, 0);
});
test("unavailable model paths fail without counting or inventing a weaker fallback", async () => {
  const local = port("local"),
    cloud = port("cloud");
  local.prepare = async () => {
    throw Error("cache unsupported");
  };
  cloud.prepare = async () => {
    throw Error("service busy");
  };
  const hybrid = createHybridRecognition({ local, cloud, prepareDelayMs: 0 });
  await assert.rejects(hybrid.recognize({}, { attempt: 1 }));
  assert.equal(local.calls, 0);
  assert.equal(cloud.calls, 0);
  hybrid.dispose();
});
test("a stalled download and unavailable cloud give bounded feedback while later readiness can recover", async () => {
  const loading = deferred(),
    local = port("local", loading.promise),
    cloud = port("cloud");
  cloud.prepare = async () => {
    throw Error("service busy");
  };
  const hybrid = createHybridRecognition({
    local,
    cloud,
    prepareDelayMs: 0,
    readyTimeoutMs: 5,
  });
  await assert.rejects(hybrid.recognize({}, { attempt: 1 }), /still preparing/);
  loading.resolve();
  await tick();
  assert.equal((await hybrid.recognize({}, { attempt: 2 })).selected, null);
  hybrid.dispose();
});
test("local execution failure falls back once and a transient cloud preparation failure can recover on a user read", async () => {
  const local = port("local"),
    cloud = port("cloud");
  local.recognize = async () => {
    throw Error("worker crashed");
  };
  const hybrid = createHybridRecognition({ local, cloud, prepareDelayMs: 0 });
  await hybrid.prepare();
  const result = await hybrid.recognize({}, { attempt: 1 });
  assert.equal(result.measurement.provider, "cloud");
  assert.equal(result.measurement.failedProviders.length, 1);
  assert.equal(result.selected, null);
  hybrid.dispose();
  const failingLocal = port("local");
  failingLocal.prepare = async () => {
    throw Error("unavailable");
  };
  cloud.prepare = async () => {
    if (cloud.prepares++ === 1) throw Error("temporary busy");
  };
  const retry = createHybridRecognition({
    local: failingLocal,
    cloud,
    prepareDelayMs: 0,
  });
  await assert.rejects(retry.prepare());
  assert.equal(
    (await retry.recognize({}, { attempt: 2 })).measurement.provider,
    "cloud",
  );
  retry.dispose();
});
