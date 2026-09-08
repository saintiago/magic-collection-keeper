import {
  createCompactSearch,
  decodeCompactNames,
} from "../domain/compact-names.js";
import { catalogStorage } from "./catalog-storage.js";
const WEEK = 7 * 86400000;
export function createWorkerCatalog({
  storage = catalogStorage(),
  fetcher = fetch,
  now = Date.now,
  emit = () => {},
} = {}) {
  let current,
    pending,
    checked = 0,
    retry = 0,
    failed = false,
    storageError = false;
  const metric = (phase, started, extra = {}) =>
    emit({ type: "metric", phase, ms: performance.now() - started, ...extra });
  function metadata() {
    return {
      ...current.manifest,
      stale:
        failed ||
        now() - Date.parse(current.manifest.updated_at) > 2 * WEEK + 86400000,
    };
  }
  function announce() {
    emit({
      type: "state",
      ready: Boolean(current),
      version: current?.manifest.browser.version,
      storageError,
      stale: current ? metadata().stale : true,
    });
  }
  function validate(m) {
    if (
      m?.schema !== 1 ||
      m.browser?.schema !== 1 ||
      !/^[a-f0-9]{64}$/.test(m.browser.version) ||
      !Number.isFinite(Date.parse(m.updated_at)) ||
      !Number.isInteger(m.identities) ||
      m.identities < 1 ||
      m.browser.bytes > 15000000
    )
      throw Error("Invalid catalog manifest");
  }
  async function prepare(manifest, bytes) {
    validate(manifest);
    if (
      !(bytes instanceof ArrayBuffer) ||
      bytes.byteLength !== manifest.browser.bytes
    )
      throw Error("Invalid catalog bytes");
    const t = performance.now();
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== manifest.browser.version)
      throw Error("Catalog checksum mismatch");
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 60000000) throw Error("Catalog too large");
        chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
    const data = decodeCompactNames(raw);
    metric("decode", t, { bytes: bytes.byteLength, expandedBytes: length });
    if (data.cards.length !== manifest.identities)
      throw Error("Incomplete catalog");
    const start = performance.now(),
      search = createCompactSearch(data);
    metric("index", start, { identities: data.cards.length });
    return { manifest, bytes, search };
  }
  async function save() {
    try {
      await storage.write({
        manifest: current.manifest,
        bytes: current.bytes,
        checked,
      });
      storageError = false;
    } catch {
      storageError = true;
    }
    announce();
  }
  async function refresh() {
    if (pending || now() < retry || (current && now() - checked < WEEK))
      return pending;
    pending = (async () => {
      const t = performance.now();
      try {
        const response = await fetcher("/catalog/current.json", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw Error("Catalog unavailable");
        const manifest = await response.json();
        validate(manifest);
        if (
          current &&
          Date.parse(manifest.updated_at) <
            Date.parse(current.manifest.updated_at)
        )
          throw Error("Catalog regression");
        if (current?.manifest.browser.version !== manifest.browser.version) {
          const result = await fetcher(
            `/catalog/${manifest.browser.version}.names.gz`,
            { signal: AbortSignal.timeout(20000) },
          );
          if (!result.ok) throw Error("Catalog download unavailable");
          const bytes = await result.arrayBuffer();
          const next = await prepare(manifest, bytes);
          // The complete validated search object replaces the old version together.
          current = next;
        } else current = { ...current, manifest };
        checked = now();
        failed = false;
        announce();
        await save();
        metric("refresh", t, { version: manifest.browser.version });
      } catch {
        failed = true;
        retry = now() + 300000;
        announce();
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  }
  return {
    async start() {
      const t = performance.now();
      try {
        const saved = await storage.read();
        if (saved) {
          current = await prepare(saved.manifest, saved.bytes);
          checked =
            Number.isFinite(saved.checked) && saved.checked <= now()
              ? saved.checked
              : 0;
          announce();
          metric("restore", t);
        }
      } catch {
        storageError = true;
      }
      void refresh();
    },
    search(query) {
      void refresh();
      if (!current) throw Error("Catalog not ready");
      const t = performance.now(),
        suggestions = current.search
          .search(query, { suggest: true })
          .slice(0, 8);
      return {
        suggestions,
        catalog: metadata(),
        timing: { phase: "search", ms: performance.now() - t },
      };
    },
    refresh,
  };
}
