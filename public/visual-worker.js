// SPDX-License-Identifier: AGPL-3.0-only
// Model preprocessing/dewarp follows the pinned CollectorVision browser worker.
import * as ort from "./vendor/ort/ort.webgpu.min.mjs";
import {
  orderCorners,
  quadArea,
  isUsableQuad,
  computeHomography,
  applyHomography,
  sampleBilinear,
  normalizeEmbedding,
  FLOAT16_LOOKUP,
} from "./collectorvision-math.js";
import { loadVisualAssets } from "./visual-assets.js";
let detector,
  embedder,
  records,
  embeddings,
  manifest,
  busy = false;
const mean = [0.485, 0.456, 0.406],
  std = [0.229, 0.224, 0.225];
function tensor(canvas, size) {
  const scaled = new OffscreenCanvas(size, size),
    ctx = scaled.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, size, size);
  const rgba = ctx.getImageData(0, 0, size, size).data,
    plane = size * size,
    values = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++)
      values[c * plane + i] = (rgba[i * 4 + c] / 255 - mean[c]) / std[c];
  return new ort.Tensor("float32", values, [1, 3, size, size]);
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
function warp(frame, corners) {
  const width = 448,
    height = 448,
    source = frame
      .getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, frame.width, frame.height);
  const inverse = computeHomography(
    [
      [0, 0],
      [447, 0],
      [447, 447],
      [0, 447],
    ],
    corners.map(([x, y]) => [x * frame.width, y * frame.height]),
  );
  const crop = new OffscreenCanvas(width, height),
    ctx = crop.getContext("2d"),
    target = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [sx, sy] = applyHomography(inverse, x, y),
        offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        target.data[offset + c] = sampleBilinear(
          source.data,
          frame.width,
          frame.height,
          sx,
          sy,
          c,
        );
      target.data[offset + 3] = 255;
    }
  ctx.putImageData(target, 0, 0);
  return crop;
}
function search(query) {
  const best = [];
  for (let row = 0; row < records.length; row++) {
    let score = 0;
    const offset = row * 128;
    for (let col = 0; col < 128; col++)
      score += FLOAT16_LOOKUP[embeddings[offset + col]] * query[col];
    if (best.length < 5 || score > best.at(-1).score) {
      best.push({ row, score });
      best.sort((a, b) => b.score - a.score);
      if (best.length > 5) best.pop();
    }
  }
  return best;
}
async function initialize(enableWebGpu) {
  const started = performance.now();
  ort.env.wasm.numThreads = 1; // No hidden dependency on COOP/COEP or extra workers.
  ort.env.wasm.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;
  const loaded = await loadVisualAssets((progress) =>
    self.postMessage({ type: "progress", ...progress }),
  );
  ({ manifest } = loaded);
  records = loaded.assets.records;
  embeddings = new Uint16Array(loaded.assets.embeddings);
  let provider = "wasm",
    gpuAvailable = false,
    fallback = null;
  if (enableWebGpu && navigator.gpu) {
    try {
      gpuAvailable = Boolean(await navigator.gpu.requestAdapter());
    } catch {
      gpuAvailable = false;
    }
  }
  const initStart = performance.now();
  // Detector always uses WASM: upstream reported numerical errors on ARM GPU.
  detector = await ort.InferenceSession.create(loaded.assets.cornelius, {
    executionProviders: ["wasm"],
  });
  if (gpuAvailable) {
    try {
      embedder = await ort.InferenceSession.create(loaded.assets.milo, {
        executionProviders: ["webgpu"],
      });
      provider = "wasm-detector/webgpu-embedder";
    } catch {
      fallback = "WebGPU initialization failed";
    }
  }
  if (!embedder)
    embedder = await ort.InferenceSession.create(loaded.assets.milo, {
      executionProviders: ["wasm"],
    });
  self.postMessage({
    type: "ready",
    metrics: {
      ...loaded.metrics,
      prepareMs: performance.now() - started,
      sessionInitMs: performance.now() - initStart,
      provider,
      gpuAvailable,
      fallback,
      catalogRows: records.length,
      catalogPackedBytes: embeddings.byteLength,
      workerMemoryAvailable: false,
      ortVersion: "1.29.0",
    },
  });
}
async function recognize(bitmap, attempt) {
  const started = performance.now(),
    frame = new OffscreenCanvas(bitmap.width, bitmap.height);
  frame.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
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
  const crop = warp(frame, corners),
    t2 = performance.now(),
    embedded = normalizeEmbedding((await run(embedder, tensor(crop, 448)))[0]),
    t3 = performance.now(),
    matches = search(embedded);
  const first = matches[0],
    identity = records[first.row].oracle_id,
    other =
      matches.slice(1).find((m) => records[m.row].oracle_id !== identity)
        ?.score ?? 1;
  const supported = first.score >= 0.8 && first.score - other >= 0.08;
  return {
    ...base,
    status: supported ? "possible" : "unknown",
    candidates: supported ? matches.map((m) => records[m.row]) : [],
    evidence: {
      ...base.evidence,
      topScore: first.score,
      differentIdentityMargin: first.score - other,
      isProbability: false,
      scoreKind: "cosine_similarity",
    },
    timings: {
      ...base.timings,
      dewarpMs: t2 - t1,
      embedMs: t3 - t2,
      searchMs: performance.now() - t3,
      totalMs: performance.now() - started,
    },
  };
}
self.onmessage = async ({ data }) => {
  if (busy) {
    data.bitmap?.close();
    self.postMessage({ type: "error", message: "Visual worker busy" });
    return;
  }
  busy = true;
  try {
    if (data.type === "init") await initialize(data.enableWebGpu === true);
    else if (data.type === "frame")
      self.postMessage({
        type: "result",
        result: await recognize(data.bitmap, data.attempt),
      });
  } catch {
    data.bitmap?.close();
    self.postMessage({
      type: "error",
      message: "Browser visual recognition unavailable",
    });
  } finally {
    busy = false;
  }
};
