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
  finish({
    attempt: 1,
    contractVersion: 1,
    status: "possible",
    candidates: [],
  });
  await assert.rejects(pending, { name: "AbortError" });
  const unsafe = createBackendRecognition({
    request: async () => ({
      attempt: 2,
      contractVersion: 1,
      status: "confirmed",
    }),
  });
  await assert.rejects(
    unsafe.recognize(canvas, { attempt: 2 }),
    /not approved/,
  );
  const wrong = createBackendRecognition({
    request: async () => ({
      attempt: 3,
      contractVersion: 1,
      status: "possible",
    }),
  });
  await assert.rejects(wrong.recognize(canvas, { attempt: 2 }), /not approved/);
});
test("possible response without a canonical identity cannot suggest a printing", async () => {
  const port = createBackendRecognition({
    request: async () => ({
      attempt: 1,
      contractVersion: 1,
      status: "possible",
      candidates: [],
    }),
  });
  const { measurement, ...row } = await port.recognize(canvas, { attempt: 1 });
  assert.ok(measurement.hydrateMs >= 0);
  assert.deepEqual(row, {
    status: "possible",
    waitingForSingleCard: false,
    candidates: [],
    selected: null,
    suggested: false,
    query: "",
    note: "Suggested printing. Check set, collector number and language; use Find to see other printings.",
    name: "Unclear reading",
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
  });
});

test("canonical printing lookup rejects mismatched identities and ignores unknown candidates", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    oracle_id = "00000000-0000-4000-8000-000000000002";
  const candidate = { id, oracle_id, name: "Sol Ring" };
  const calls = [];
  const request = async (path, options) => {
    calls.push(path);
    if (path === "/api/recognize") {
      assert.equal(JSON.parse(options.body).attempt, 1);
      return {
        contractVersion: 1,
        attempt: 1,
        status: "possible",
        candidates: [candidate],
      };
    }
    assert.equal(
      new URL(path, "http://test").searchParams.get("oracle"),
      oracle_id,
    );
    return {
      cards: [{ ...candidate, oracle_id: "wrong", finishes: ["nonfoil"] }],
    };
  };
  const result = await createBackendRecognition({ request }).recognize(canvas, {
    attempt: 1,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.selected, null);
  const unknown = createBackendRecognition({
    request: async () => ({
      contractVersion: 1,
      attempt: 1,
      status: "unknown",
      candidates: [candidate],
    }),
  });
  assert.equal(
    (await unknown.recognize(canvas, { attempt: 1 })).candidates.length,
    0,
  );
});
