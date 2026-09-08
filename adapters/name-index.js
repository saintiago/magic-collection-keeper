import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createNameSearch } from "../domain/card-names.js";
import {
  createCompactSearch,
  decodeCompactNames,
} from "../domain/compact-names.js";
import { ApplicationError } from "../domain/inventory.js";

export function createNameIndex({
  origin,
  directory = "build/catalog",
  fetcher = fetch,
  now = Date.now,
  seedDirectory,
  onMetric = () => {},
} = {}) {
  let current,
    expires = 0,
    pending,
    refreshError = false;
  const WEEK = 7 * 86400000;
  let seed;
  const descriptor = (m) => m.server || m.browser;
  const asset = (m) =>
    m.server
      ? `${m.server.version}.server.gz`
      : m.browser
        ? `${m.browser.version}.names.gz`
        : `${m.version}.json.gz`;
  async function materialize(manifest, compressed) {
    if (
      manifest.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.version) ||
      !Number.isFinite(Date.parse(manifest.updated_at)) ||
      (descriptor(manifest) && descriptor(manifest).schema !== 1)
    )
      throw Error("Invalid catalog manifest");
    const hash = descriptor(manifest)?.version || manifest.version;
    if (createHash("sha256").update(compressed).digest("hex") !== hash)
      throw Error("Catalog checksum mismatch");
    const start = performance.now();
    const raw = gunzipSync(compressed, { maxOutputLength: 60000000 });
    const data = descriptor(manifest)
      ? decodeCompactNames(raw)
      : JSON.parse(raw.toString());
    if (
      (descriptor(manifest) ? data.cards.length : data.length) !==
      manifest.identities
    )
      throw Error("Incomplete catalog");
    const parsed = performance.now();
    const search = descriptor(manifest)
      ? createCompactSearch(data)
      : createNameSearch(data);
    onMetric({ phase: "index-decode", ms: parsed - start });
    onMetric({ phase: "index-build", ms: performance.now() - parsed });
    return { search, metadata: manifest };
  }
  async function bytes(path) {
    if (!origin) return readFile(`${directory}/${path}`);
    const r = await fetcher(`${origin}/catalog/${path}`, {
      signal: AbortSignal.timeout(path === "current.json" ? 5000 : 10000),
      redirect: "error",
    });
    if (!r.ok) throw Error("Catalog snapshot unavailable");
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > 25000000) throw Error("Catalog snapshot too large");
    return data;
  }
  async function refresh() {
    const manifest = JSON.parse((await bytes("current.json")).toString());
    if (
      manifest.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.version) ||
      !Number.isFinite(Date.parse(manifest.updated_at))
    )
      throw Error("Invalid catalog manifest");
    if (
      current &&
      Date.parse(manifest.updated_at) < Date.parse(current.metadata.updated_at)
    )
      throw Error("Catalog regression");
    if (
      current?.metadata.version !== manifest.version ||
      current?.metadata.browser?.version !== manifest.browser?.version ||
      current?.metadata.server?.version !== manifest.server?.version
    ) {
      if (
        descriptor(manifest) &&
        !/^[a-f0-9]{64}$/.test(descriptor(manifest).version)
      )
        throw Error("Invalid browser version");
      const started = performance.now();
      const compressed = await bytes(asset(manifest));
      onMetric({ phase: "index-download", ms: performance.now() - started });
      current = await materialize(manifest, compressed);
    }
    current.metadata = manifest;
    expires = now() + WEEK;
    refreshError = false;
  }
  return {
    async get() {
      if (seedDirectory) {
        if (!seed)
          seed = (async () => {
            try {
              const manifest = JSON.parse(
                await readFile(`${seedDirectory}/current.json`, "utf8"),
              );
              if (!/^[a-f0-9]{64}$/.test(descriptor(manifest)?.version)) return;
              current = await materialize(
                manifest,
                await readFile(`${seedDirectory}/${asset(manifest)}`),
              );
            } catch {}
          })();
        await seed;
      }
      if (!current || now() >= expires) {
        if (!pending)
          pending = refresh()
            .catch((error) => {
              refreshError = true;
              expires = now() + 300000;
              if (!current)
                throw new ApplicationError(
                  "Card names are temporarily unavailable. Retry shortly.",
                  503,
                );
            })
            .finally(() => {
              pending = null;
            });
        if (!current) await pending;
      }
      return {
        ...current,
        metadata: {
          ...current.metadata,
          stale:
            refreshError ||
            now() - Date.parse(current.metadata.updated_at) >
              2 * WEEK + 86400000,
        },
      };
    },
  };
}
