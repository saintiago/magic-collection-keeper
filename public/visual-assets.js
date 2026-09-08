// SPDX-License-Identifier: AGPL-3.0-only
const base = new URL("./vendor/visual/", import.meta.url);
async function digest(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function loadVisualAssets(onProgress) {
  const response = await fetch(new URL("manifest.json", base));
  if (!response.ok) throw new Error("Visual models unavailable");
  const manifest = await response.json();
  if (
    manifest.schema !== 1 ||
    manifest.rows !== 112049 ||
    manifest.dims !== 128
  )
    throw new Error("Unsupported visual catalog");
  let cache;
  try {
    cache = await caches.open("keeper-visual-v1");
  } catch {
    /* Visit-only cache. */
  }
  const assets = {},
    metrics = { downloadBytes: 0, cacheBytes: 0, assetMs: 0 };
  const started = performance.now();
  for (const name of ["cornelius", "milo", "embeddings", "records"]) {
    const spec = manifest.assets[name];
    if (
      !spec ||
      !/^[0-9a-f]{64}\.(onnx|gz)$/.test(spec.file) ||
      spec.file.split(".")[0] !== spec.sha256 ||
      !(spec.bytes > 0 && spec.bytes < 40000000)
    )
      throw new Error("Invalid visual asset manifest");
    const url = new URL(spec.file, base);
    let buffer,
      hit = false;
    try {
      const saved = await cache?.match(url);
      if (saved) {
        buffer = await saved.arrayBuffer();
        hit =
          buffer.byteLength === spec.bytes &&
          (await digest(buffer)) === spec.sha256;
      }
    } catch {
      /* A corrupt/evicted cache is repaired by verified download. */
    }
    if (!hit) {
      const result = await fetch(url);
      if (!result.ok) throw new Error("Visual asset download failed");
      buffer = await result.arrayBuffer();
      if (
        buffer.byteLength !== spec.bytes ||
        (await digest(buffer)) !== spec.sha256
      )
        throw new Error("Visual asset integrity check failed");
      try {
        await cache?.put(url, new Response(buffer));
      } catch {
        /* Visit-only. */
      }
    }
    metrics[hit ? "cacheBytes" : "downloadBytes"] += buffer.byteLength;
    onProgress?.({ stage: name, cached: hit, bytes: buffer.byteLength });
    if (spec.file.endsWith(".gz")) {
      buffer = await new Response(
        new Blob([buffer])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
    }
    assets[name] =
      name === "records"
        ? JSON.parse(new TextDecoder().decode(buffer))
        : buffer;
  }
  if (
    assets.embeddings.byteLength !== manifest.rows * manifest.dims * 2 ||
    assets.records.length !== manifest.rows
  )
    throw new Error("Visual catalog rows do not match");
  metrics.assetMs = performance.now() - started;
  return { assets, manifest, metrics };
}
