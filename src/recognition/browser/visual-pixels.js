// SPDX-License-Identifier: AGPL-3.0-only
import {
  computeHomography,
  applyHomography,
  sampleBilinear,
} from "./collectorvision-math.js";
const mean = [0.485, 0.456, 0.406],
  std = [0.229, 0.224, 0.225];

// Half-pixel bilinear resize, RGB/ImageNet normalization. Works in workers that
// support WASM but lack OffscreenCanvas (including the Windows WebKit test engine).
export function normalizedPixels(frame, size, rotate = false) {
  const plane = size * size,
    values = new Float32Array(plane * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sx = ((x + 0.5) * frame.width) / size - 0.5;
      let sy = ((y + 0.5) * frame.height) / size - 0.5;
      if (rotate) {
        sx = frame.width - 1 - sx;
        sy = frame.height - 1 - sy;
      }
      for (let c = 0; c < 3; c++)
        values[c * plane + y * size + x] =
          (sampleBilinear(frame.data, frame.width, frame.height, sx, sy, c) /
            255 -
            mean[c]) /
          std[c];
    }
  return values;
}

export function warpPixels(frame, corners) {
  const width = 448,
    height = 448;
  const inverse = computeHomography(
    [
      [0, 0],
      [447, 0],
      [447, 447],
      [0, 447],
    ],
    corners.map(([x, y]) => [x * frame.width, y * frame.height]),
  );
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [sx, sy] = applyHomography(inverse, x, y),
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
