import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createScanSession } from "../public/scan-session.js";

const oracle = randomUUID();
const row = (scanId) => ({
  scanId,
  captureId: randomUUID(),
  name: "Test card",
  quantity: 1,
  finish: "nonfoil",
  condition: "NM",
  selected: {
    id: randomUUID(),
    oracle_id: oracle,
    name: "Test card",
    finishes: ["nonfoil"],
  },
});
function fixture() {
  let saved,
    lost = false,
    failure = false,
    peakBytes = 0;
  const receipts = new Map();
  const storage = {
    journal(value) {
      peakBytes = Math.max(peakBytes, JSON.stringify(value).length);
      saved = structuredClone(value);
    },
    async write(value) {
      if (failure) throw Error("disk unavailable");
      saved = structuredClone(value);
    },
  };
  const stage = async (input) => {
    const prior = receipts.get(input.batch.id);
    if (prior) assert.deepEqual(prior, input);
    else receipts.set(input.batch.id, structuredClone(input));
    if (lost) {
      lost = false;
      throw Error("response lost");
    }
    return {
      staged_id: input.batch.id,
      session_id: input.id,
      index: input.index,
    };
  };
  return {
    storage,
    stage,
    receipts,
    saved: () => saved,
    peak: () => peakBytes,
    lose: () => {
      lost = true;
    },
    fail: (value) => {
      failure = value;
    },
  };
}
test("SCAN-12/13 a lost batch response recovers the exact operation and last identity after reload", async () => {
  const f = fixture();
  let session = createScanSession({ ...f, saved: undefined });
  const rows = [row(1), row(2)];
  await session.checkpoint(rows, { lastOracle: oracle, attempt: 2 });
  f.lose();
  await assert.rejects(session.seal(rows), /response lost/);
  const outgoing = f.saved().outgoing;
  rows[0].quantity = 9; // A UI retry cannot mutate the frozen operation.
  await session.checkpoint(rows);
  assert.deepEqual(f.saved().outgoing, outgoing);
  session = createScanSession({ ...f, saved: f.saved() });
  const recovered = await session.seal(session.current().rows);
  assert.equal(f.receipts.size, 1);
  assert.equal(recovered.rows.length, 0);
  assert.equal(recovered.archived, 2);
  assert.equal(recovered.lastOracle, oracle);
  assert.equal(recovered.attempt, 2);
  assert.equal(recovered.recent[0].quantity, 1);
});
test("SCAN-12/13 storage backpressure preserves the outgoing batch and never sends an undurable intent", async () => {
  const f = fixture(),
    session = createScanSession({ ...f, saved: undefined }),
    rows = [row(1)];
  await session.checkpoint(rows, { lastOracle: oracle });
  f.fail(true);
  await assert.rejects(session.seal(rows), /disk unavailable/);
  assert.equal(f.receipts.size, 0);
  assert.equal(session.current().rows.length, 1);
  f.fail(false);
  await session.seal(rows);
  assert.equal(f.receipts.size, 1);
  await assert.rejects(
    session.checkpoint(Array.from({ length: 51 }, (_, i) => row(i))),
    /Wait/,
  );
});
test("SCAN-12/13 2000 incremental captures retain bounded journal/history and monotonic recovery", async () => {
  const f = fixture();
  let session = createScanSession({ ...f, saved: undefined }),
    peakRows = 0;
  for (let batch = 0; batch < 40; batch++) {
    const rows = [];
    for (let i = 1; i <= 50; i++) {
      rows.push(row(batch * 50 + i));
      await session.checkpoint(rows, {
        lastOracle: oracle,
        attempt: batch * 50 + i,
      });
      peakRows = Math.max(
        peakRows,
        session.current().rows.length + session.current().recent.length,
      );
    }
    await session.seal(rows);
    session = createScanSession({ ...f, saved: f.saved() });
  }
  assert.equal(session.current().archived, 2000);
  assert.equal(session.current().attempt, 2000);
  assert.equal(session.current().index, 40);
  assert.equal(session.current().recent.length, 10);
  assert.equal(f.receipts.size, 40);
  assert.ok(peakRows <= 60);
  assert.ok(f.peak() < 100000, `bounded serialized journal: ${f.peak()} bytes`);
});

test("SCAN-13 corrupt session state is rejected without overwriting the journal", async () => {
  const f = fixture();
  const good = createScanSession({ ...f, saved: undefined });
  await good.checkpoint([row(1)], { lastOracle: oracle });
  for (const patch of [
    { rows: [null] },
    { id: "invalid" },
    { lastOracle: "invalid" },
    { archived: -1 },
    { rows: Array.from({ length: 51 }, () => row(1)) },
  ]) {
    assert.throws(
      () => createScanSession({ ...f, saved: { ...f.saved(), ...patch } }),
      /safely/,
    );
  }
  assert.equal(f.saved().rows.length, 1);
});

test("SCAN-13 overlapping checkpoints coalesce writes and preserve the latest durable state", async () => {
  let release,
    calls = 0,
    stored;
  const storage = {
    journal() {},
    async write(value) {
      calls++;
      if (calls === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      stored = structuredClone(value);
    },
  };
  const session = createScanSession({
    storage,
    stage: async () => {
      throw Error("unexpected stage");
    },
  });
  const first = row(1),
    second = row(2);
  const a = session.checkpoint([first], { lastOracle: oracle, attempt: 1 });
  const b = session.checkpoint([first, second], {
    lastOracle: oracle,
    attempt: 2,
  });
  const c = session.checkpoint([{ ...first, quantity: 3 }, second], {
    lastOracle: oracle,
    attempt: 2,
  });
  release();
  await Promise.all([a, b, c]);
  assert.equal(calls, 2);
  assert.equal(stored.rows.length, 2);
  assert.equal(stored.rows[0].quantity, 3);
  assert.equal(stored.revision, 3);
});
