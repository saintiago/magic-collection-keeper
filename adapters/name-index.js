import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createNameSearch } from "../domain/card-names.js";
import { ApplicationError } from "../domain/inventory.js";

export function createNameIndex({
  origin,
  directory = "build/catalog",
  fetcher = fetch,
  now = Date.now,
} = {}) {
  let current,
    expires = 0,
    pending,
    refreshError = false;
  const DAY = 86400000;
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
    if (current?.metadata.version !== manifest.version) {
      const compressed = await bytes(`${manifest.version}.json.gz`);
      if (
        createHash("sha256").update(compressed).digest("hex") !==
        manifest.version
      )
        throw Error("Catalog checksum mismatch");
      const rows = JSON.parse(
        gunzipSync(compressed, { maxOutputLength: 150000000 }).toString(),
      );
      if (!Array.isArray(rows) || rows.length !== manifest.identities)
        throw Error("Invalid catalog index");
      current = { search: createNameSearch(rows), metadata: manifest };
    }
    current.metadata = manifest;
    expires = now() + DAY;
    refreshError = false;
  }
  return {
    async get() {
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
        await pending;
      }
      return {
        ...current,
        metadata: {
          ...current.metadata,
          stale:
            refreshError ||
            now() - Date.parse(current.metadata.updated_at) > 3 * DAY,
        },
      };
    },
  };
}
