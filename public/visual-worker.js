// SPDX-License-Identifier: AGPL-3.0-only
// Model preprocessing/dewarp follows the pinned CollectorVision browser worker.
import {
  orderCorners,
  quadArea,
  isUsableQuad,
  normalizeEmbedding,
} from "./collectorvision-math.js";
import { loadVisualAssets, loadVisualRuntime } from "./visual-assets.js";
import { searchVisualCatalog } from "./visual-search.js";
import { normalizedPixels, warpPixels } from "./visual-pixels.js";
import { lightingVariants } from "./visual-lighting.js";
let ort,
  detector,
  embedder,
  records,
  embeddings,
  manifest,
  busy = false;
function tensor(frame, size, rotate = false) {
  return new ort.Tensor("float32", normalizedPixels(frame, size, rotate), [
    1,
    3,
    size,
    size,
  ]);
}
async function run(model, input) {
  let outputs;
  try {
    outputs = await model.run({ [model.inputNames[0]]: input });
    return model.outputNames.map((name) =>
      Float32Array.from(outputs[name].data),
    );
  } finally {
    input.dispose();
    if (outputs) for (const output of Object.values(outputs)) output.dispose();
  }
}
async function initialize() {
  const started = performance.now();
  ort = await import("./vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 1; // No hidden dependency on COOP/COEP or extra workers.
  ort.env.wasm.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;
  const loaded = await loadVisualAssets((progress) =>
    self.postMessage({ type: "progress", ...progress }),
  );
  ({ manifest } = loaded);
  records = loaded.assets.records;
  embeddings = new Uint16Array(loaded.assets.embeddings);
  const initStart = performance.now();
  const runtime = await loadVisualRuntime();
  ort.env.wasm.wasmBinary = runtime.buffer;
  detector = await ort.InferenceSession.create(loaded.assets.cornelius, {
    executionProviders: ["wasm"],
  });
  embedder = await ort.InferenceSession.create(loaded.assets.milo, {
    executionProviders: ["wasm"],
  });
  self.postMessage({
    type: "ready",
    metrics: {
      ...loaded.metrics,
      ...runtime.metrics,
      prepareMs: performance.now() - started,
      sessionInitMs: performance.now() - initStart,
      provider: "wasm",
      catalogRows: records.length,
      catalogPackedBytes: embeddings.byteLength,
      workerMemoryAvailable: false,
      ortVersion: "1.29.0",
    },
  });
}
async function recognize(frame, attempt) {
  const started = performance.now();
  const out = await run(detector, tensor(frame, 384)),
    t1 = performance.now();
  const points = [];
  for (let i = 0; i < 8; i += 2)
    points.push([
      Math.max(0, Math.min(1, out[0][i])),
      Math.max(0, Math.min(1, out[0][i + 1])),
    ]);
  const corners = orderCorners(points, frame.width, frame.height),
    sharpness = out[2]?.[0],
    area = quadArea(corners);
  const base = {
    contractVersion: 1,
    attempt,
    status: "unknown",
    candidates: [],
    selected: null,
    evidence: { sharpness, calibrated: false },
    versions: {
      visual: {
        adapter: "collectorvision-browser",
        processing: "keeper-visual-v4-bounded-lighting",
        code: manifest.upstream.code,
        catalog: manifest.upstream.catalog,
      },
    },
    timings: { detectMs: t1 - started },
  };
  if (!(
    sharpness >= 0.02 &&
    area > 0.12 &&
    area < 0.98 &&
    isUsableQuad(corners)
  )) {
    base.timings.totalMs = performance.now() - started;
    return base;
  }
  self.postMessage({ type: "stage", attempt, stage: "visual", active: true });
  const crop = warpPixels(frame, corners),
    t2 = performance.now(),
    embedded = normalizeEmbedding((await run(embedder, tensor(crop, 448)))[0]),
    t3 = performance.now();
  let found = searchVisualCatalog(embedded, embeddings, records),
    orientation = "upright",
    extraEmbedMs = 0;
  // Shortest-edge ordering can place the physical bottom at the top. The pinned
  // upstream scanner evaluates both orientations; skip the second only when
  // upright already supports optional candidates under the research threshold.
  if (
    found.matches[0].score < 0.8 ||
    found.matches[0].score - found.differentIdentityScore < 0.08
  ) {
    const rotateStart = performance.now();
    const opposite = normalizeEmbedding(
      (await run(embedder, tensor(crop, 448, true)))[0],
    );
    extraEmbedMs = performance.now() - rotateStart;
    const alternative = searchVisualCatalog(opposite, embeddings, records);
    if (alternative.matches[0].score > found.matches[0].score) {
      found = alternative;
      orientation = "rotated_180";
    }
  }
  const originalTopScore = found.matches[0].score;
  let preprocessing = "original";
  if (
    originalTopScore < 0.8 &&
    originalTopScore >= 0.6 &&
    originalTopScore - found.differentIdentityScore >= 0.12
  ) {
    const identity = records[found.matches[0].row].oracle_id;
    for (const variant of lightingVariants(crop)) {
      for (const rotated of [false, true]) {
        const began = performance.now();
        const embedding = normalizeEmbedding(
          (await run(embedder, tensor(variant.frame, 448, rotated)))[0],
        );
        extraEmbedMs += performance.now() - began;
        const alternative = searchVisualCatalog(embedding, embeddings, records);
        if (
          records[alternative.matches[0].row].oracle_id === identity &&
          alternative.matches[0].score > found.matches[0].score
        ) {
          found = alternative;
          orientation = rotated ? "rotated_180" : "upright";
          preprocessing = variant.name;
        }
      }
      if (
        found.matches[0].score >= 0.8 &&
        found.matches[0].score - found.differentIdentityScore >= 0.08
      )
        break;
    }
  }
  const { matches, differentIdentityScore: other } = found,
    first = matches[0];
  const supported = first.score >= 0.8 && first.score - other >= 0.08;
  return {
    ...base,
    status: supported ? "possible" : "unknown",
    candidates: supported ? matches.map((m) => records[m.row]) : [],
    evidence: {
      ...base.evidence,
      orientation,
      preprocessing,
      originalTopScore,
      topScore: first.score,
      differentIdentityMargin: first.score - other,
      isProbability: false,
      scoreKind: "cosine_similarity",
    },
    timings: {
      ...base.timings,
      dewarpMs: t2 - t1,
      embedMs: t3 - t2 + extraEmbedMs,
      searchMs: performance.now() - t3 - extraEmbedMs,
      totalMs: performance.now() - started,
    },
  };
}
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({ type: "error", message: "Visual worker busy" });
    return;
  }
  busy = true;
  try {
    if (data.type === "init") await initialize();
    else if (data.type === "frame")
      self.postMessage({
        type: "result",
        result: await recognize(data.frame, data.attempt),
      });
  } catch {
    self.postMessage({
      type: "error",
      message: "Browser visual recognition unavailable",
    });
  } finally {
    if (data.type === "frame")
      self.postMessage({
        type: "stage",
        attempt: data.attempt,
        stage: "visual",
        active: false,
      });
    busy = false;
  }
};
