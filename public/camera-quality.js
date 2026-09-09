import { visualDifference } from "./scan-transition.js";

// Compare only adjacent views of the same stable scene. No names or recognition
// scores influence departure, rearming, or the chosen physical capture.
export function frameQuality({ data, width, height }) {
  let energy = 0,
    clipped = 0,
    sum = 0,
    square = 0;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    const value = (data[p] + data[p + 1] + data[p + 2]) / 3;
    gray[i] = value;
    sum += value;
    square += value * value;
    if (value < 12 || value > 243) clipped++;
  }
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      energy +=
        (4 * gray[i] -
          gray[i - 1] -
          gray[i + 1] -
          gray[i - width] -
          gray[i + width]) **
        2;
    }
  const contrast = Math.max(
    100,
    square / gray.length - (sum / gray.length) ** 2,
  );
  return (
    (energy / Math.max(1, (width - 2) * (height - 2)) / contrast) *
    (1 - clipped / gray.length) ** 2
  );
}

export function createFrameBurst() {
  let frames = [];
  return {
    observe(canvas, signature, now, quality) {
      frames = frames.filter(
        (f) =>
          now - f.now <= 300 && visualDifference(f.signature, signature) <= 5,
      );
      frames.push({ canvas, signature, now, quality });
      if (frames.length > 3) frames.shift();
    },
    take() {
      const best = frames.reduce(
        (a, b) => (!a || b.quality >= a.quality ? b : a),
        null,
      );
      frames = [];
      return best?.canvas;
    },
    clear() {
      frames = [];
    },
  };
}

export function captureQuality(canvas) {
  const small = document.createElement("canvas");
  small.width = 96;
  small.height = 128;
  const context = small.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, 96, 128);
  return frameQuality(context.getImageData(0, 0, 96, 128));
}
