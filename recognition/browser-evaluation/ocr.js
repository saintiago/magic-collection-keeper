// SPDX-License-Identifier: AGPL-3.0-only
// Experimental browser port: frozen Paddle weights, BGR preprocessing and CTC.
// Axis-aligned connected components on rectified card bands deliberately differ
// from RapidOCR's rotated polygon postprocessing. Measure; do not assume parity.
import {
  computeHomography,
  applyHomography,
  sampleBilinear,
} from "/collectorvision-math.js";
import { verifiedAsset } from "/visual-assets.js";

function region(frame, corners, start, end) {
  const width = 800,
    fullHeight = 1120,
    y0 = Math.floor(fullHeight * start),
    height = Math.floor(fullHeight * end) - y0;
  const inverse = computeHomography(
    [
      [0, 0],
      [799, 0],
      [799, 1119],
      [0, 1119],
    ],
    corners.map(([x, y]) => [x * frame.width, y * frame.height]),
  );
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [sx, sy] = applyHomography(inverse, x, y + y0),
        offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        data[offset + c] = sampleBilinear(
          frame.data,
          frame.width,
          frame.height,
          sx,
          sy,
          c,
        );
      data[offset + 3] = 255;
    }
  return { width, height, data };
}
function inputPixels(
  frame,
  width,
  height,
  box = [0, 0, frame.width, frame.height],
  recognize = false,
) {
  const [left, top, w, h] = box,
    plane = width * height,
    data = new Float32Array(plane * 3);
  const actualWidth = recognize
    ? Math.min(width, Math.ceil((height * w) / h))
    : width;
  const mean = [0.485, 0.456, 0.406],
    std = [0.229, 0.224, 0.225];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < actualWidth; x++)
      for (let c = 0; c < 3; c++) {
        const value =
          sampleBilinear(
            frame.data,
            frame.width,
            frame.height,
            left + ((x + 0.5) * w) / actualWidth - 0.5,
            top + ((y + 0.5) * h) / height - 0.5,
            2 - c,
          ) / 255;
        data[c * plane + y * width + x] = recognize
          ? (value - 0.5) / 0.5
          : (value - mean[c]) / std[c];
      }
  return data;
}
export function textBoxes(map, width, height, limit = 16) {
  const visited = new Uint8Array(width * height),
    queue = new Int32Array(width * height),
    boxes = [];
  for (let first = 0; first < map.length; first++) {
    if (visited[first] || map[first] < 0.3) continue;
    let head = 0,
      tail = 1,
      minX = first % width,
      maxX = minX,
      minY = Math.floor(first / width),
      maxY = minY;
    queue[0] = first;
    visited[first] = 1;
    while (head < tail) {
      const pixel = queue[head++],
        x = pixel % width,
        y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy,
            next = ny * width + nx;
          if (
            nx < 0 ||
            nx >= width ||
            ny < 0 ||
            ny >= height ||
            visited[next] ||
            map[next] < 0.3
          )
            continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1;
    if (Math.min(w, h) < 3) continue;
    let score = 0;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) score += map[y * width + x];
    if (score / (w * h) < 0.6) continue;
    const expansion = (w * h * 1.5) / (2 * (w + h));
    const left = Math.max(0, Math.floor(minX - expansion)),
      top = Math.max(0, Math.floor(minY - expansion));
    boxes.push([
      left,
      top,
      Math.min(width, Math.ceil(maxX + 1 + expansion)) - left,
      Math.min(height, Math.ceil(maxY + 1 + expansion)) - top,
    ]);
    if (boxes.length >= 1000) break;
  }
  return boxes
    .sort((a, b) => (Math.abs(a[1] - b[1]) < 10 ? a[0] - b[0] : a[1] - b[1]))
    .slice(0, limit);
}
export function decodeCtc(data, dimensions, characters) {
  const classes = dimensions.at(-1),
    steps = dimensions.at(-2);
  let previous = -1,
    text = "",
    score = 0,
    count = 0;
  for (let t = 0; t < steps; t++) {
    let index = 0,
      value = -Infinity;
    for (let c = 0; c < classes; c++)
      if (data[t * classes + c] > value) {
        value = data[t * classes + c];
        index = c;
      }
    if (index !== 0 && index !== previous) {
      text += characters[index] || "";
      score += value;
      count++;
    }
    previous = index;
  }
  return { text, score: count ? score / count : 0 };
}
export async function createLocalOcr(ort) {
  const specs = {
    "det.onnx": {
      bytes: 4819576,
      sha256:
        "0c5eeee2f49f63ef01626bf3cd149bab5d2e51b820a096abf916ff11771d51e5",
    },
    "rec.onnx": {
      bytes: 8058635,
      sha256:
        "f02a06e3b977228e884e789677b13532d948cea353610dbaf8174110c3b4f2fa",
    },
    "latin.txt": {
      bytes: 2616,
      sha256:
        "ccbcc45730b3fbbd9050c5bc74db6a99067141ef1035e3d14889a84a6b9b1aff",
    },
  };
  let cache;
  try {
    cache = await caches.open("keeper-ocr-evaluation-v1");
  } catch {}
  const assets = {},
    started = performance.now();
  let downloadBytes = 0,
    cacheBytes = 0;
  for (const [name, spec] of Object.entries(specs)) {
    const result = await verifiedAsset(
      new URL("/evaluation-assets/" + name, import.meta.url),
      spec,
      cache,
    );
    assets[name] = result.buffer;
    if (result.hit) cacheBytes += spec.bytes;
    else downloadBytes += spec.bytes;
  }
  const detector = await ort.InferenceSession.create(assets["det.onnx"], {
    executionProviders: ["wasm"],
  });
  const recognizer = await ort.InferenceSession.create(assets["rec.onnx"], {
    executionProviders: ["wasm"],
  });
  const characters = [
    "blank",
    ...new TextDecoder()
      .decode(assets["latin.txt"])
      .replace(/\r/g, "")
      .replace(/\n$/, "")
      .split("\n"),
    " ",
  ];
  const prepareMs = performance.now() - started;
  async function run(session, pixels, width, height) {
    const tensor = new ort.Tensor("float32", pixels, [1, 3, height, width]);
    let outputs;
    try {
      outputs = await session.run({ [session.inputNames[0]]: tensor });
      const first = outputs[session.outputNames[0]];
      return { data: Float32Array.from(first.data), dims: [...first.dims] };
    } finally {
      tensor.dispose();
      if (outputs) for (const item of Object.values(outputs)) item.dispose();
    }
  }
  async function readBand(frame, corners, start, end) {
    const began = performance.now(),
      band = region(frame, corners, start, end),
      preprocessed = performance.now();
    const width = Math.max(32, Math.round(band.width / 32) * 32),
      height = Math.max(32, Math.round(band.height / 32) * 32);
    const map = await run(
        detector,
        inputPixels(band, width, height),
        width,
        height,
      ),
      detected = performance.now();
    const mapWidth = map.dims.at(-1),
      mapHeight = map.dims.at(-2);
    const boxes = textBoxes(map.data, mapWidth, mapHeight).map(
      ([x, y, w, h]) => [
        (x * band.width) / mapWidth,
        (y * band.height) / mapHeight,
        (w * band.width) / mapWidth,
        (h * band.height) / mapHeight,
      ],
    );
    const lines = [];
    let inferenceMs = 0;
    for (const box of boxes) {
      const width = Math.min(
          1920,
          Math.max(320, Math.ceil((48 * box[2]) / box[3])),
        ),
        started = performance.now();
      const result = await run(
        recognizer,
        inputPixels(band, width, 48, box, true),
        width,
        48,
      );
      inferenceMs += performance.now() - started;
      const decoded = decodeCtc(result.data, result.dims, characters);
      if (decoded.score >= 0.8) lines.push(decoded);
    }
    return {
      lines,
      boxes: boxes.length,
      timings: {
        preprocessMs: preprocessed - began,
        detectMs: detected - preprocessed,
        recognizeMs: inferenceMs,
        totalMs: performance.now() - began,
      },
    };
  }
  return {
    metrics: {
      prepareMs,
      downloadBytes,
      cacheBytes,
      weightsBytes: 12880827,
      postprocessing: "axis-aligned-components-v1",
    },
    async readFull(frame) {
      const start = performance.now(),
        scale = Math.min(1, 1280 / Math.max(frame.width, frame.height));
      const width = Math.max(32, Math.round((frame.width * scale) / 32) * 32),
        height = Math.max(32, Math.round((frame.height * scale) / 32) * 32);
      const map = await run(
          detector,
          inputPixels(frame, width, height),
          width,
          height,
        ),
        detected = performance.now();
      const mw = map.dims.at(-1),
        mh = map.dims.at(-2);
      const boxes = textBoxes(map.data, mw, mh, 48).map(([x, y, w, h]) => [
        (x * frame.width) / mw,
        (y * frame.height) / mh,
        (w * frame.width) / mw,
        (h * frame.height) / mh,
      ]);
      const top = Math.min(...boxes.map((box) => box[1])),
        bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
      const titleBoxes = boxes
          .filter((box) => box[1] < top + (bottom - top) * 0.23)
          .slice(0, 16),
        lines = [];
      for (const box of titleBoxes) {
        const w = Math.min(
          1920,
          Math.max(320, Math.ceil((48 * box[2]) / box[3])),
        );
        const result = await run(
          recognizer,
          inputPixels(frame, w, 48, box, true),
          w,
          48,
        );
        const decoded = decodeCtc(result.data, result.dims, characters);
        if (decoded.score >= 0.8) lines.push({ ...decoded, box });
      }
      return {
        lines,
        boxes: boxes.length,
        titleBoxes: titleBoxes.length,
        timings: {
          detectMs: detected - start,
          recognizeMs: performance.now() - detected,
          totalMs: performance.now() - start,
        },
      };
    },
    async read(frame, corners, { footer = true } = {}) {
      const title = await readBand(frame, corners, 0.02, 0.12),
        bottom = footer ? await readBand(frame, corners, 0.92, 1) : null;
      return {
        title: title.lines.map((line) => line.text),
        footer: bottom?.lines.map((line) => line.text) || [],
        timings: { title: title.timings, footer: bottom?.timings || null },
        boxes: { title: title.boxes, footer: bottom?.boxes || 0 },
      };
    },
    async dispose() {
      await detector.release();
      await recognizer.release();
    },
  };
}
