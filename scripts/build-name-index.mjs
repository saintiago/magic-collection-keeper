import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  buildCompactNames,
  encodeCompactNames,
  createCompactSearch,
} from "../domain/compact-names.js";
import {
  createNameIndexBuilder,
  createNameSearch,
} from "../domain/card-names.js";

const directory = "build/catalog";
await mkdir(directory, { recursive: true });
await mkdir("data/catalog", { recursive: true });
const local = process.env.SCRYFALL_BULK_FILE;
let metadata, path;
if (local) {
  metadata = JSON.parse(
    await readFile(process.env.SCRYFALL_BULK_METADATA, "utf8"),
  );
  path = local;
} else {
  const response = await fetch("https://api.scryfall.com/bulk-data/all_cards", {
    headers: {
      "User-Agent": "MagicCollectionKeeper/0.1",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      `Bulk metadata unavailable (${response.status}); keep the last published index.`,
    );
  metadata = await response.json();
  const url = new URL(metadata.jsonl_download_uri);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "data.scryfall.io" ||
    !url.pathname.endsWith(".jsonl.gz")
  )
    throw Error("Unexpected official bulk download URL");
  path = "data/catalog/" + url.pathname.split("/").pop();
  try {
    await stat(path);
  } catch {
    const download = await fetch(url, {
      signal: AbortSignal.timeout(600000),
      redirect: "error",
    });
    if (!download.ok) throw Error("Bulk download failed");
    await pipeline(download.body, createWriteStream(path + ".partial"));
    await rename(path + ".partial", path);
  }
}
if (
  metadata.type !== "all_cards" ||
  !Number.isFinite(Date.parse(metadata.updated_at)) ||
  Date.now() - Date.parse(metadata.updated_at) > 7 * 86400000
)
  throw Error(
    "Bulk data must be an official all-language snapshot from the last seven days",
  );
const started = performance.now(),
  builder = createNameIndexBuilder();
let records = 0;
for await (const line of createInterface({
  input: createReadStream(path).pipe(createGunzip()),
  crlfDelay: Infinity,
})) {
  if (!line.trim()) continue;
  builder.add(JSON.parse(line));
  records++;
}
const rows = builder.finish();
if (rows.length < 30000)
  throw Error("Incomplete name index; keep the published catalog");
const compressed = gzipSync(JSON.stringify(rows), { level: 9 });
const compact = buildCompactNames(rows);
const browserBytes = gzipSync(encodeCompactNames(compact), {
  level: 9,
});
const browserVersion = createHash("sha256").update(browserBytes).digest("hex");
const version = createHash("sha256").update(compressed).digest("hex");
const manifest = {
  schema: 1,
  version,
  updated_at: metadata.updated_at,
  built_at: new Date().toISOString(),
  identities: rows.length,
  aliases: rows.reduce((n, row) => n + row[3].length, 0),
  bytes: compressed.length,
  browser: { schema: 1, version: browserVersion, bytes: browserBytes.length },
  source: metadata.uri || "https://api.scryfall.com/bulk-data/all_cards",
};
const index = createNameSearch(rows);
const browserSearch = createCompactSearch(compact);
const queries = new Set([
    "Piracy",
    "Piarcy",
    "relampa",
    "Fuego",
    "火",
    "Lightning Blot",
    "nephilim",
    "zzzzzzzz",
  ]),
  languages = new Set();
for (const row of rows)
  for (const [name, language] of row[3])
    if (!languages.has(language)) {
      languages.add(language);
      queries.add(name);
    }
for (const query of queries)
  for (const suggest of [true, false])
    if (
      JSON.stringify(index.search(query, { suggest })) !==
      JSON.stringify(browserSearch.search(query, { suggest }))
    )
      throw Error("Browser catalog ranking parity failed");
if (
  index.search("Piracy")[0]?.name !== "Piracy" ||
  !index
    .search("relampa", { suggest: true })
    .some((r) => r.name === "Lightning Bolt" && r.matched_name === "Relámpago")
)
  throw Error("Real catalog acceptance failed; keep the previous index");
await writeFile(`${directory}/${version}.json.gz`, compressed);
await writeFile(`${directory}/${browserVersion}.names.gz`, browserBytes);
await writeFile(`${directory}/current.json`, JSON.stringify(manifest));
console.log(
  JSON.stringify({
    ...manifest,
    bulkRecords: records,
    buildMilliseconds: Math.round(performance.now() - started),
    heapMegabytes: Math.round(process.memoryUsage().heapUsed / 1048576),
  }),
);
