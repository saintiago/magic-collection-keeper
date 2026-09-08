import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  buildCompactNames,
  encodeCompactNames,
  decodeCompactNames,
  createCompactSearch,
  prepareCompactNames,
} from "../domain/compact-names.js";
import { createNameSearch } from "../domain/card-names.js";
import { createWorkerCatalog } from "../public/name-worker-runtime.js";
import { createDetailCache } from "../public/detail-cache.js";
import { createDiscoveryService } from "../application/discovery.js";
import { createScryfallCatalog } from "../adapters/scryfall.js";
import { createNameIndex } from "../adapters/name-index.js";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const rows = [
  ["a", "Piracy", "a-en", [["Piratería", "es"]]],
  ["b", "Coastal Piracy", "b-en", []],
  ["c", "Conspiracy", "c-en", []],
  [
    "d",
    "Lightning Bolt",
    "d-en",
    [
      ["Relámpago", "es"],
      ["稲妻", "ja"],
    ],
  ],
  ["e", "Thunderbolt", "e-en", [["Relâmpago", "pt"]]],
  [
    "f",
    "Fire // Ice",
    "f-en",
    [
      ["Fire", "en"],
      ["Fuego", "es"],
      ["火", "ja"],
      ["Ice", "en"],
    ],
  ],
  ["g", "Glint-Eye Nephilim", "g-en", [["Nephilim brilleœil", "fr"]]],
];
function snapshot(entries = rows, date = Date.now()) {
  const bytes = gzipSync(encodeCompactNames(buildCompactNames(entries)));
  return {
    manifest: {
      schema: 1,
      version: "a".repeat(64),
      identities: entries.length,
      updated_at: new Date(date).toISOString(),
      browser: {
        schema: 1,
        version: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
    },
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}
test("UC-33 binary catalog preserves full multilingual ranking, faces, ambiguity and fuzzy fallback", () => {
  const data = decodeCompactNames(encodeCompactNames(buildCompactNames(rows))),
    search = createCompactSearch(data),
    reference = createNameSearch(rows);
  for (const query of [
    "Piracy",
    "PIRÁCY",
    "coastal",
    "pir",
    "relampa",
    "Relámpago",
    "火",
    "稲妻",
    "Fuego",
    "Ice",
    "NÉPHILIM",
    "brilleœil",
    "Lightning Blot",
    "zzzzzzzz",
    "p",
  ])
    for (const suggest of [true, false])
      assert.deepEqual(
        search.search(query, { suggest }),
        reference.search(query, { suggest }),
        query,
      );
  assert.throws(() => decodeCompactNames(new Uint8Array([1, 2, 3])));
  data.terms[0] = 999999;
  assert.throws(() => createCompactSearch(data));
});
test("UC-33 worker restores verified last-good, checks weekly, atomically swaps and retains good data on corruption/storage failure", async () => {
  let time = Date.now(),
    remote = snapshot(rows, time),
    saved,
    reads = 0,
    fail = false,
    deny = false;
  const storage = {
    read: async () => saved,
    write: async (v) => {
      if (deny) throw Error("denied");
      saved = structuredClone(v);
    },
  };
  const fetcher = async (path) => {
    reads++;
    if (fail) throw Error("offline");
    return path.endsWith("current.json")
      ? Response.json(remote.manifest)
      : new Response(remote.bytes);
  };
  const worker = createWorkerCatalog({ storage, fetcher, now: () => time });
  await worker.start();
  await worker.refresh();
  assert.equal(worker.search("relampa").suggestions[0].name, "Lightning Bolt");
  assert.equal(reads, 2);
  const restored = createWorkerCatalog({ storage, fetcher, now: () => time });
  await restored.start();
  assert.equal(reads, 2);
  assert.equal(restored.search("Piracy").suggestions[0].name, "Piracy");
  time += 7 * 86400000 + 1;
  remote = snapshot(
    rows.map((r) => (r[0] === "a" ? ["a", "Updated Piracy", r[2], r[3]] : r)),
    time,
  );
  const old = restored.search("Piracy");
  assert.equal(old.suggestions[0].name, "Piracy");
  await restored.refresh();
  assert.equal(
    restored.search("Updated Piracy").suggestions[0].name,
    "Updated Piracy",
  );
  time += 7 * 86400000 + 1;
  remote = { ...snapshot(rows, time), bytes: new ArrayBuffer(4) };
  await restored.refresh();
  assert.equal(restored.search("Updated Piracy").catalog.stale, true);
  assert.equal(
    restored.search("Updated Piracy").suggestions[0].name,
    "Updated Piracy",
  );
  time += 300001;
  remote = snapshot(rows, time);
  deny = true;
  await restored.refresh();
  assert.equal(restored.search("Piracy").suggestions[0].name, "Piracy");
  assert.equal(
    saved.manifest.browser.version !== remote.manifest.browser.version,
    true,
  );
  fail = true;
  const cold = createWorkerCatalog({
    storage: {
      read: async () => ({ ...saved, bytes: new ArrayBuffer(4) }),
      write: storage.write,
    },
    fetcher,
    now: () => time,
  });
  await cold.start();
  await cold.refresh();
  assert.throws(() => cold.search("Piracy"));
});
test("UC-34 printing cache reuses prior batches, validates selected identity without index, and browser TTL never grants ownership", async () => {
  const ids = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    ],
    oracle = "33333333-3333-3333-3333-333333333333";
  const stored = new Map(),
    calls = [];
  let fail = false;
  const catalog = createScryfallCatalog({
    cache: {
      getCards: async (keys) => keys.map((k) => stored.get(k)).filter(Boolean),
      get: async () => null,
      put: async (_k, r) => r.cards.forEach((c) => stored.set(c.id, c)),
    },
    rateLimit: { acquire: async () => {}, pause: async () => {} },
    fetcher: async (_url, options) => {
      if (fail) throw Error("offline");
      const requested = JSON.parse(options.body).identifiers.map((i) => i.id);
      calls.push(requested);
      return Response.json({
        data: requested.map((id) => ({
          id,
          oracle_id: oracle,
          name: "Card",
          lang: "en",
          games: ["paper"],
        })),
      });
    },
  });
  await catalog.resolve(ids);
  await catalog.resolve([ids[0]]);
  assert.equal(calls.length, 1);
  const service = createDiscoveryService({
    names: {
      get: () => {
        throw Error("Index must not load");
      },
    },
    catalog,
  });
  const result = await service.discover("Card", 1, oracle, ids[0]);
  assert.equal(result.cards[0].id, ids[0]);
  await assert.rejects(
    () => service.discover("Card", 1, ids[1], ids[0]),
    (e) => e.status === 503,
  );
  await assert.rejects(
    () => service.discover("Card", 1, oracle, "invalid"),
    (e) => e.status === 400,
  );
  let time = 0,
    loads = 0;
  const browser = createDetailCache({ now: () => time });
  browser.remember(result.cards);
  const load = () => {
    loads++;
    return result;
  };
  await browser.load(oracle, ids[0], load);
  assert.equal(loads, 0);
  time = 86400001;
  await browser.load(oracle, ids[0], load);
  assert.equal(loads, 1);
  fail = true;
  stored.clear();
  await assert.rejects(() => catalog.resolve(ids));
});
test("UC-33 packaged verified seed serves during an unfinished manifest check and rejects regression", async () => {
  const data = snapshot(),
    dir = await mkdtemp(join(tmpdir(), "keeper-index-test-"));
  const compact = buildCompactNames(rows);
  compact.prepared = prepareCompactNames(compact);
  const bytes = gzipSync(encodeCompactNames(compact));
  data.manifest.server = {
    schema: 1,
    version: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  const file = join(dir, `${data.manifest.server.version}.server.gz`),
    manifest = join(dir, "current.json");
  await writeFile(file, bytes);
  await writeFile(manifest, JSON.stringify(data.manifest));
  let release,
    requests = 0;
  const remote = new Promise((resolve) => (release = resolve));
  try {
    const index = createNameIndex({
      seedDirectory: dir,
      origin: "https://catalog.test",
      fetcher: () => {
        requests++;
        return remote;
      },
    });
    const values = await Promise.all([index.get(), index.get()]);
    assert.equal(values[0].search.search("Piracy")[0].name, "Piracy");
    assert.equal(requests, 1);
    release(
      Response.json({ ...data.manifest, updated_at: "2000-01-01T00:00:00Z" }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await index.get()).metadata.stale, true);
    assert.equal(
      (await index.get()).metadata.updated_at,
      data.manifest.updated_at,
    );
  } finally {
    release(Response.json(data.manifest));
    await unlink(file);
    await unlink(manifest);
    await rmdir(dir);
  }
});
