// SPDX-License-Identifier: AGPL-3.0-only
// Same bounded transforms as the server adapter; original pixels always run first.
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function lightingVariants(frame) {
  const hist = Array.from({ length: 3 }, () => new Uint32Array(256));
  const count = frame.width * frame.height;
  let sum = 0;
  for (let i = 0; i < frame.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      hist[c][frame.data[i + c]]++;
      sum += frame.data[i + c];
    }
  const mean = clamp(sum / (count * 3), 1, 254);
  const gamma = clamp(Math.log(110 / 255) / Math.log(mean / 255), 0.65, 1.5);
  const high = hist.map((bins) => {
    let total = 0;
    for (let value = 0; value < 256; value++) {
      total += bins[value];
      if (total > Math.floor((count - 1) * 0.95)) return value;
    }
    return 255;
  });
  const average = high.reduce((n, v) => n + v, 0) / 3;
  const gains = high.map((v) => clamp(average / Math.max(1, v), 0.65, 1.6));
  function transform(name, value) {
    const data = new Uint8ClampedArray(frame.data.length);
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.floor(clamp(value(frame.data[i + c], c), 0, 255));
      data[i + 3] = 255;
    }
    return { name, frame: { width: frame.width, height: frame.height, data } };
  }
  const variants = [];
  if (Math.abs(gamma - 1) > 0.05)
    variants.push(transform("exposure", (v) => 255 * (v / 255) ** gamma));
  if (Math.max(...gains) - Math.min(...gains) > 0.08)
    variants.push(transform("highlight_balance", (v, c) => v * gains[c]));
  return variants;
}
