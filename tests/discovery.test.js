import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  createNameIndexBuilder,
  createNameSearch,
  normalizeName,
} from "../domain/card-names.js";
import { createNameIndex } from "../adapters/name-index.js";
import { createDiscoveryService } from "../application/discovery.js";
import { createScryfallCatalog } from "../adapters/scryfall.js";

const rows = [
  ["piracy", "Piracy", "piracy-en", [["Piratería", "es"]]],
  ["coastal", "Coastal Piracy", "coastal-en", []],
  ["conspiracy", "Conspiracy", "conspiracy-en", []],
  [
    "bolt",
    "Lightning Bolt",
    "bolt-en",
    [
      ["Relámpago", "es"],
      ["稲妻", "ja"],
    ],
  ],
  ["arc", "Arc Lightning", "arc-en", [["Relámpago arco", "es"]]],
  ["thunder", "Thunderbolt", "thunder-en", [["Relâmpago", "pt"]]],
  [
    "fire",
    "Fire // Ice",
    "fire-en",
    [
      ["Fire", "en"],
      ["Fuego", "es"],
      ["火", "ja"],
      ["Ice", "en"],
    ],
  ],
];
const cards = rows.map(([oracle_id, name, id]) => ({
  oracle_id,
  name,
  id,
  lang: "en",
  games: ["paper"],
  finishes: ["nonfoil"],
  oracle_text: "English rules.",
}));

test("UC-31 alias explanation hides overlapping English and face matches without changing rank", () => {
  const search = createNameSearch([
    ...rows,
    ["neph", "Glint-Eye Nephilim", "neph-en", [["Nephilim brilleœil", "fr"]]],
    ["accent", "Éowyn, Shieldmaiden", "eowyn-en", [["Éowyn", "fr"]]],
    [
      "faces",
      "A Combined Title",
      "face-en",
      [
        ["English Face", "en"],
        ["English", "fr"],
      ],
    ],
  ]);
  for (const query of ["nephilim", "NÉPHILIM", "eowyn", "ÉOWYN", "English"]) {
    const result = search.search(query)[0];
    assert.equal(result.matched_name, null, query);
    assert.equal(result.matched_language, null, query);
  }
  const neph = search.search("nephilim")[0];
  assert.equal(neph.rank, 1); // French prefix remains the rank even though English also matches.
  assert.equal(
    neph.completion_length,
    normalizeName("Nephilim brilleœil").length,
  );
  assert.equal(search.search("brilleœil")[0].matched_language, "fr");
  assert.equal(search.search("relampa")[0].matched_name, "Relámpago");
  assert.equal(search.search("fuego")[0].matched_language, "es");
  assert.equal(search.search("Ice")[0].matched_name, null);
});
test("UC-24 exact English first, translated accentless prefixes, face aliases, ambiguous identities and deterministic fuzzy ranking", () => {
  const search = createNameSearch(rows);
  assert.deepEqual(
    search.search("PIRÁCY").map((r) => r.name),
    ["Piracy", "Coastal Piracy", "Conspiracy"],
  );
  const matches = search.search("relampa", { suggest: true });
  assert.equal(matches[0].name, "Lightning Bolt");
  assert.equal(matches[0].matched_name, "Relámpago");
  assert(matches.some((r) => r.name === "Thunderbolt"));
  assert.equal(new Set(matches.map((r) => r.oracle_id)).size, matches.length);
  assert.equal(search.search("fuego")[0].name, "Fire // Ice");
  assert.equal(search.search("火", { suggest: true })[0].name, "Fire // Ice");
  assert.equal(search.search("Piarcy")[0].name, "Piracy");
  assert.deepEqual(search.search("qzxqzxqzx"), []);
  assert.equal(normalizeName("  RELÁMPAGO  "), "relampago");
});
test("UC-24 bulk builder collapses translated printings, preserves face aliases and excludes identities without an English paper printing", () => {
  const builder = createNameIndexBuilder();
  for (const card of [
    ...cards,
    { ...cards[3], id: "bolt-es", lang: "es", printed_name: "Relámpago" },
    { ...cards[3], id: "bolt-en-2", released_at: "2025-01-01" },
    {
      ...cards[6],
      card_faces: [
        { name: "Fire", printed_name: "Fuego" },
        { name: "Ice", printed_name: "Hielo" },
      ],
      lang: "es",
    },
    { ...cards[0], oracle_id: "foreign-only", lang: "es" },
    { ...cards[0], oracle_id: "digital", digital: true },
  ])
    builder.add(card);
  const built = builder.finish();
  assert.equal(built.length, 7);
  assert.equal(built.find((r) => r[0] === "bolt")[2], "bolt-en-2");
  assert.equal(createNameSearch(built).search("hielo")[0].name, "Fire // Ice");
  assert(built.every((r) => !r[2].endsWith("-es")));
});
test("UC-25 discovery shares concurrent canonical reads, repeats from cache and rejects non-English/wrong-identity catalog results", async () => {
  let resolves = 0;
  const names = {
    get: async () => ({
      search: createNameSearch(rows),
      metadata: { version: "v1", updated_at: "2026-09-08T00:00:00Z" },
    }),
  };
  const catalog = {
    resolve: async (ids) => {
      resolves++;
      return cards.filter((c) => ids.includes(c.id));
    },
  };
  const service = createDiscoveryService({ names, catalog });
  const [a, b] = await Promise.all([
    service.discover("Piracy"),
    service.discover("Piracy"),
  ]);
  assert.equal(resolves, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.cards.map((c) => c.name),
    ["Piracy", "Coastal Piracy", "Conspiracy"],
  );
  await service.discover("Piracy");
  assert.equal(resolves, 1);
  assert.equal(
    (await service.suggest("relampa")).suggestions[0].name,
    "Lightning Bolt",
  );
  assert.equal(resolves, 1);
  assert.equal(
    (await service.discover("Lightning Bolt", 1, "bolt")).cards.length,
    1,
  );
  await assert.rejects(
    () => service.discover("x", 1, "missing"),
    (e) => e.status === 404,
  );
  const bad = createDiscoveryService({
    names,
    catalog: { resolve: async () => [{ ...cards[0], lang: "es" }] },
  });
  await assert.rejects(
    () => bad.discover("Piracy"),
    (e) => e.status === 503,
  );
});
test("UC-25 name index loads once concurrently, checks freshness/version/hash, retains stale data after refresh failure and retries cold failure", async () => {
  let time = Date.now(),
    count = 0,
    fail = false;
  let blob = gzipSync(JSON.stringify(rows));
  const manifest = () => ({
    schema: 1,
    version: createHash("sha256").update(blob).digest("hex"),
    updated_at: new Date(time).toISOString(),
    identities: rows.length,
  });
  const fetcher = async (url) => {
    count++;
    if (fail) throw Error("offline");
    return url.endsWith("current.json")
      ? Response.json(manifest())
      : new Response(blob);
  };
  const index = createNameIndex({
    origin: "https://catalog.test",
    fetcher,
    now: () => time,
  });
  await Promise.all([index.get(), index.get()]);
  assert.equal(count, 2);
  await index.get();
  assert.equal(count, 2);
  time += 86400001;
  fail = true;
  assert.equal((await index.get()).metadata.stale, true);
  assert.equal((await index.get()).search.search("Piracy")[0].name, "Piracy");
  fail = false;
  time += 300001;
  blob = gzipSync(
    JSON.stringify(
      rows.map((r) =>
        r[0] === "piracy" ? [r[0], "Updated Piracy", r[2], r[3]] : r,
      ),
    ),
  );
  assert.equal(
    (await index.get()).search.identity("piracy").name,
    "Updated Piracy",
  );
  const cold = createNameIndex({
    origin: "https://catalog.test",
    fetcher: async () => {
      throw Error("offline");
    },
  });
  await assert.rejects(
    () => cold.get(),
    (e) => e.status === 503,
  );
  const corrupt = createNameIndex({
    origin: "https://catalog.test",
    fetcher: async (url) =>
      url.endsWith("current.json")
        ? Response.json(manifest())
        : new Response("corrupt"),
  });
  await assert.rejects(
    () => corrupt.get(),
    (e) => e.status === 503,
  );
});
test("UC-24 advanced discovery requests only English identities while printing search preserves languages and editions", async () => {
  const seen = [],
    cache = new Map();
  const catalog = createScryfallCatalog({
    cache: {
      get: async (k) => cache.get(k),
      put: async (k, v) => cache.set(k, v),
    },
    rateLimit: { acquire: async () => {}, pause: async () => {} },
    fetcher: async (url) => {
      seen.push(new URL(url).searchParams);
      return Response.json({
        data: [cards[0], cards[0], { ...cards[0], id: "es", lang: "es" }],
        total_cards: 1,
        has_more: false,
      });
    },
  });
  assert.equal((await catalog.discover("set:por", 1)).cards.length, 1);
  assert.equal(seen[0].get("unique"), "cards");
  assert(seen[0].get("q").endsWith("lang:en"));
  await catalog.search("set:por lang:es", 1);
  assert.equal(seen[1].get("unique"), "prints");
  assert.equal(seen[1].get("include_multilingual"), "true");
  await catalog.discover("set:por", 1);
  assert.equal(seen.length, 2);
});
