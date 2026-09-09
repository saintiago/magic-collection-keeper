// SPDX-License-Identifier: AGPL-3.0-only
// No CollectorVision geometry, embedding model, or printing reference index.
import { createLocalOcr } from "/evaluation/ocr.js";
import { normalizeTitle } from "/evaluation/policy.js";
import { loadVisualRuntime, verifiedAsset } from "/visual-assets.js";
import { orderCorners, quadArea, isUsableQuad } from "/collectorvision-math.js";
import { normalizedPixels } from "/visual-pixels.js";
const geometryMode =
  new URL(self.location.href).searchParams.get("mode") === "geometry-ocr";
let ocr,
  titles,
  detector,
  ort,
  busy = false;
async function initialize() {
  const started = performance.now();
  ort = await import("/vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = new URL("/vendor/ort/", self.location.href).href;
  const runtime = await loadVisualRuntime();
  ort.env.wasm.wasmBinary = runtime.buffer;
  ocr = await createLocalOcr(ort);
  let geometryMetrics = null;
  if (geometryMode) {
    const manifest = await (await fetch("/vendor/visual/manifest.json")).json(),
      spec = manifest.assets.cornelius;
    const loaded = await verifiedAsset(
      new URL("/vendor/visual/" + spec.file, self.location.href),
      spec,
      await caches.open("keeper-ocr-evaluation-v1"),
    );
    detector = await ort.InferenceSession.create(loaded.buffer, {
      executionProviders: ["wasm"],
    });
    geometryMetrics = { bytes: spec.bytes, cached: loaded.hit };
  }
  const catalog = await verifiedAsset(
    new URL("/evaluation-assets/title-names.json.gz", self.location.href),
    {
      bytes: 5575604,
      sha256:
        "5566869e7008c2d7943a5983460141e094bc3db2c0cca2afcc3adea219986766",
    },
    await caches.open("keeper-ocr-evaluation-v1"),
  );
  const rows = await new Response(
    new Response(catalog.buffer).body.pipeThrough(
      new DecompressionStream("gzip"),
    ),
  ).json();
  titles = new Map();
  for (const [oracle, name, printing, aliases] of rows) {
    if (normalizeTitle(name).length < 8) continue; // Short names remain unknown without visual evidence.
    for (const [value, language] of [[name, "en"], ...aliases]) {
      const key = normalizeTitle(value);
      if (!key) continue;
      const list = titles.get(key) || [];
      if (!list.some((item) => item.oracle_id === oracle))
        list.push({ id: printing, oracle_id: oracle, name, language });
      titles.set(key, list);
    }
  }
  self.postMessage({
    type: "ready",
    metrics: {
      ...runtime.metrics,
      ocr: ocr.metrics,
      geometry: geometryMetrics,
      titleCatalogBytes: 5575604,
      titleCatalogCached: catalog.hit,
      prepareMs: performance.now() - started,
      visualModels: geometryMode ? "card-geometry-only" : false,
      visualReferenceIndex: false,
      shortTitles:
        "English identity names below eight normalized characters deliberately unsupported",
      workerMemoryAvailable: false,
    },
  });
}
function identities(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i],
      chain = [{ ...first, index: i }];
    for (let j = i + 1; j < lines.length && chain.length < 3; j++) {
      const next = lines[j],
        previous = chain.at(-1),
        [x, y, w, h] = next.box,
        [px, py, pw, ph] = previous.box;
      const overlap = Math.min(x + w, px + pw) - Math.max(x, px);
      if (
        y > py + ph * 0.5 &&
        y < py + ph * 3 &&
        overlap > Math.min(w, pw) * 0.2
      )
        chain.push({ ...next, index: j });
    }
    for (let length = 1; length <= chain.length; length++) {
      const part = chain.slice(0, length),
        text = part
          .map((line) => line.text)
          .join(" ")
          .trim();
      const keys = new Set([
        normalizeTitle(text),
        normalizeTitle(text.replace(/\s+\d{1,3}$/, "")),
      ]);
      for (const key of keys)
        for (const candidate of titles.get(key) || []) {
          const indexes = part.map((line) => line.index);
          if (
            !found.some(
              (old) =>
                old.candidate.oracle_id === candidate.oracle_id &&
                old.indexes.some((index) => indexes.includes(index)),
            )
          )
            found.push({ candidate, indexes });
        }
    }
  }
  return found;
}
async function recognize(frame, attempt) {
  if (geometryMode) return recognizeGeometry(frame, attempt);
  const read = await ocr.readFull(frame),
    matches = identities(read.lines);
  const unique = [
    ...new Map(
      matches.map(({ candidate }) => [candidate.oracle_id, candidate]),
    ).values(),
  ];
  const supported = matches.length === 1 && unique.length === 1;
  return {
    contractVersion: 1,
    attempt,
    status: supported ? "possible" : "unknown",
    selected: null,
    candidates: supported ? unique : [],
    evaluation: {
      mode: "ocr-only",
      top: unique.length === 1 ? unique[0] : null,
      title: { first: { title: read.lines.map((line) => line.text) } },
      matches,
      detectedText: read.lines,
      boxes: read.boxes,
      titleBoxes: read.titleBoxes,
    },
    evidence: {
      isProbability: false,
      method: "exact-title-only",
      multipleTitles: matches.length > 1,
      shortTitlesUnsupported: true,
    },
    timings: read.timings,
  };
}
async function recognizeGeometry(frame, attempt) {
  const started = performance.now(),
    input = new ort.Tensor(
      "float32",
      normalizedPixels(frame, 384),
      [1, 3, 384, 384],
    );
  let outputs;
  const base = {
    contractVersion: 1,
    attempt,
    status: "unknown",
    selected: null,
    candidates: [],
    evidence: {
      method: "card-geometry-plus-exact-title",
      isProbability: false,
    },
    evaluation: { mode: "geometry-ocr" },
    timings: {},
  };
  try {
    outputs = await detector.run({ [detector.inputNames[0]]: input });
    const points = outputs[detector.outputNames[0]].data,
      sharpness = outputs[detector.outputNames[2]].data[0];
    const corners = orderCorners(
      Array.from({ length: 4 }, (_, i) => [
        Math.max(0, Math.min(1, points[2 * i])),
        Math.max(0, Math.min(1, points[2 * i + 1])),
      ]),
      frame.width,
      frame.height,
    );
    const area = quadArea(corners);
    base.timings.detectMs = performance.now() - started;
    if (!(
      sharpness >= 0.02 &&
      area > 0.12 &&
      area < 0.98 &&
      isUsableQuad(corners)
    )) {
      base.timings.totalMs = performance.now() - started;
      return base;
    }
    const readings = [];
    let matches = [];
    for (const oriented of [
      corners,
      [...corners.slice(2), ...corners.slice(0, 2)],
    ]) {
      const reading = await ocr.read(frame, oriented, { footer: false });
      readings.push(reading);
      const text = reading.title.join(" ").trim(),
        forms = new Set([
          normalizeTitle(text),
          normalizeTitle(text.replace(/\s+\d{1,3}$/, "")),
        ]);
      matches = [
        ...new Map(
          [...forms]
            .flatMap((form) => titles.get(form) || [])
            .map((item) => [item.oracle_id, item]),
        ).values(),
      ];
      if (matches.length) break;
    }
    const supported = matches.length === 1;
    return {
      ...base,
      status: supported ? "possible" : "unknown",
      candidates: supported ? matches : [],
      evaluation: {
        mode: "geometry-ocr",
        top: supported ? matches[0] : null,
        title: { first: readings[0], opposite: readings[1] || null },
        matches,
        corners,
      },
      timings: {
        ...base.timings,
        ocrMs: performance.now() - started - base.timings.detectMs,
        totalMs: performance.now() - started,
      },
    };
  } finally {
    input.dispose();
    if (outputs) for (const item of Object.values(outputs)) item.dispose();
  }
}
self.onmessage = async ({ data }) => {
  if (busy) {
    self.postMessage({ type: "error", message: "OCR worker busy" });
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
  } catch (error) {
    self.postMessage({ type: "error", message: String(error.stack || error) });
  } finally {
    busy = false;
  }
};
