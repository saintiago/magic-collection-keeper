// Explicit local persistence soak, never part of routine CI or physical-camera proof.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { openDatabase, savePrinting } from "../../db.js";
import { createSqliteAdapters } from "../../adapters/sqlite.js";
import { createSqliteDocumentStore } from "../../adapters/document-store.js";
import { createCollectionService } from "../../application/collection.js";
import { createTaggedCollection } from "../../application/tagged-collection.js";
import { createImportDraftService } from "../../application/import-drafts.js";
import { createScanSession } from "../../public/scan-session.js";

const directory = resolve(
  process.argv[2] || "data/recognition-evaluation/scan-session-soak",
);
const duration = Number(process.argv[3] || 7200);
const captures = Number(process.argv[4] || 2000);
assert.ok(duration >= 0 && captures > 0 && captures % 50 === 0);
await mkdir(directory, { recursive: true });
const db = openDatabase(join(directory, `soak-${randomUUID()}.sqlite`));
const cards = [0, 1].map((i) => ({
  id: randomUUID(),
  oracle_id: randomUUID(),
  name: `Soak ${i}`,
  set: "tst",
  collector_number: String(i + 1),
  lang: "en",
  finishes: ["nonfoil"],
  games: ["paper"],
}));
cards.forEach((card) => savePrinting(db, card));
const { repository } = createSqliteAdapters(db),
  store = createSqliteDocumentStore(db);
const collection = createTaggedCollection({
  repository,
  store,
  newId: randomUUID,
  collection: createCollectionService({ repository, catalog: {} }),
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
const service = createImportDraftService({
  store,
  repository,
  collection,
  catalog: {},
  provider: {},
  newId: randomUUID,
});
let journal,
  peakBytes = 0,
  staged = 0,
  maxStageMs = 0;
const owner = "isolated-scan-soak";
const options = {
  storage: {
    journal(value) {
      journal = JSON.stringify(value);
      peakBytes = Math.max(peakBytes, Buffer.byteLength(journal));
    },
    write: (value) =>
      writeFile(join(directory, "journal.json"), JSON.stringify(value)),
  },
  stage: async (input) => {
    const began = performance.now();
    const result = await service.stageScanBatch(owner, input);
    staged++;
    maxStageMs = Math.max(maxStageMs, performance.now() - began);
    return result;
  },
};
let session = createScanSession(options),
  rows = [];
const began = performance.now(),
  at = new Date().toISOString(),
  samples = [];
try {
  for (let index = 1; index <= captures; index++) {
    const wait =
      began + (index * duration * 1000) / captures - performance.now();
    if (wait > 0) await sleep(wait);
    const card = cards[index % 2];
    rows.push({
      scanId: index,
      captureId: randomUUID(),
      name: card.name,
      selected: card,
      quantity: 1,
      finish: "nonfoil",
      condition: "NM",
      recognition: [],
    });
    await session.checkpoint(rows, {
      attempt: index,
      lastOracle: card.oracle_id,
    });
    if (rows.length === 50) {
      await session.seal(rows);
      const saved = JSON.parse(await readFile(join(directory, "journal.json")));
      session = createScanSession({ ...options, saved });
      rows = [];
      assert.equal(session.current().archived, index);
      assert.equal(session.current().lastOracle, card.oracle_id);
      const view = await service.getDraft(owner, { id: session.current().id });
      assert.equal(view.pending_drafts.length, 1);
      assert.equal(view.draft.rows.length, 50);
      assert.equal(view.scan_session.accepted, index);
      global.gc?.();
      const sample = {
        accepted: index,
        elapsedSeconds: (performance.now() - began) / 1000,
        journalBytes: Buffer.byteLength(journal),
        heapUsed: process.memoryUsage().heapUsed,
      };
      samples.push(sample);
      console.log(JSON.stringify(sample));
      await writeFile(
        join(directory, "progress.json"),
        JSON.stringify({ at, samples, peakBytes }, null, 2),
      );
    }
  }
  assert.deepEqual(await collection.list(owner), []);
  const report = {
    at,
    finishedAt: new Date().toISOString(),
    accepted: captures,
    elapsedSeconds: (performance.now() - began) / 1000,
    staged,
    peakBytes,
    maxStageMs,
    retainedRecent: session.current().recent.length,
    isolatedSqlite: true,
    ownershipWrites: 0,
    recognitionModelsExercised: false,
    physicalCameraVerified: false,
    scope:
      "Paced browser-session journal engine and real local atomic batch service; simulated accepted recognitions; reload recovery every batch.",
    samples,
  };
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      completed: true,
      accepted: captures,
      elapsedSeconds: report.elapsedSeconds,
      peakBytes,
    }),
  );
} finally {
  db.close();
}
