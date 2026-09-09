// SPDX-License-Identifier: AGPL-3.0-only
import {
  orderCorners,
  quadArea,
  isUsableQuad,
} from "./collectorvision-math.js";

function region(output) {
  const corners = orderCorners(
    Array.from({ length: 4 }, (_, i) => [
      output[0][i * 2],
      output[0][i * 2 + 1],
    ]),
  );
  const area = quadArea(corners),
    sharpness = output[2]?.[0];
  return {
    corners,
    area,
    sharpness,
    usable:
      isUsableQuad(corners) &&
      area > 0.06 &&
      area < 0.98 &&
      corners.every((p) =>
        p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
      ),
  };
}
function inside(point, polygon) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % 4];
    const cross =
      (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < 1e-8) continue;
    if (sign && sign !== Math.sign(cross)) return false;
    sign = Math.sign(cross);
  }
  return true;
}
function outsideFraction(primary, secondary) {
  let total = 0,
    outside = 0;
  // Bounded area estimate; this measures independent visible regions, not titles.
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const p = [(x + 0.5) / 64, (y + 0.5) / 64];
      if (inside(p, secondary)) {
        total++;
        if (!inside(p, primary)) outside++;
      }
    }
  return total ? outside / total : 0;
}
function maskRegion(frame, corners) {
  const center = corners.reduce(
    (s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4],
    [0, 0],
  );
  const expanded = corners.map((p) =>
    p.map((v, i) => center[i] + (v - center[i]) * 1.04),
  );
  const data = new Uint8ClampedArray(frame.data);
  for (let y = 0; y < frame.height; y++)
    for (let x = 0; x < frame.width; x++) {
      if (
        inside([(x + 0.5) / frame.width, (y + 0.5) / frame.height], expanded)
      ) {
        const p = (y * frame.width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = 127;
      }
    }
  return { ...frame, data };
}
export async function inspectCardRegions(frame, detect) {
  const first = region(await detect(frame));
  const base = {
    state: "ambiguous",
    method: "cornelius-masked-region-v1",
    primarySharpness: first.sharpness,
    regions: [],
  };
  if (!(first.sharpness >= 0.02)) return { ...base, state: "none" };
  if (!first.usable || first.area <= 0.12) return base;
  base.regions.push(first.corners);
  const second = region(await detect(maskRegion(frame, first.corners)));
  const visibleOutside = second.usable
    ? outsideFraction(first.corners, second.corners)
    : 0;
  const result = {
    ...base,
    secondarySharpness: second.sharpness,
    secondaryOutside: visibleOutside,
  };
  if (second.usable && visibleOutside > 0.2 && second.sharpness >= 0.02)
    return {
      ...result,
      state: "multiple",
      regions: [...base.regions, second.corners],
    };
  // A weak independent region or unstable primary geometry is not evidence of
  // exactly one card. Wait quietly instead of embedding or invoking OCR/models.
  if (
    first.sharpness < 0.06 ||
    (second.usable && visibleOutside > 0.1 && second.sharpness >= 0.01)
  )
    return result;
  return { ...result, state: "single" };
}
