// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from HanClinto/CollectorVision scanner.worker.mjs, fa7aa3ed896bcb326d7ea218c61ea7289d06803b.
// Upstream LICENSE is supplied in recognition/LICENSE and the authenticated source offer.
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function orientShortestEdgeTop(corners, width, height) {
  const edgeLengths = corners.map(([x1, y1], index) => {
    const [x2, y2] = corners[(index + 1) % corners.length];
    const dx = (x1 - x2) * width;
    const dy = (y1 - y2) * height;
    return Math.hypot(dx, dy);
  });
  let shortestEdge = 0;
  for (let i = 1; i < edgeLengths.length; i += 1) {
    if (edgeLengths[i] < edgeLengths[shortestEdge]) {
      shortestEdge = i;
    }
  }
  return corners.map(
    (_, index) => corners[(index + shortestEdge) % corners.length],
  );
}

function orderCorners(points, width = null, height = null) {
  const cx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const cy = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const sorted = [...points].sort(
    ([ax, ay], [bx, by]) =>
      Math.atan2(ay - cy, ax - cx) - Math.atan2(by - cy, bx - cx),
  );
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    const score = sorted[i][0] + sorted[i][1];
    if (score < best) {
      best = score;
      start = i;
    }
  }
  const ordered = [
    sorted[start],
    sorted[(start + 1) % 4],
    sorted[(start + 2) % 4],
    sorted[(start + 3) % 4],
  ];
  const signedArea = ordered.reduce((sum, [x1, y1], i) => {
    const [x2, y2] = ordered[(i + 1) % ordered.length];
    return sum + (x1 * y2 - x2 * y1);
  }, 0);
  const canonical =
    signedArea < 0 ? [ordered[0], ordered[3], ordered[2], ordered[1]] : ordered;
  return width && height
    ? orientShortestEdgeTop(canonical, width, height)
    : canonical;
}

function quadArea(corners) {
  let area = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[(i + 1) % corners.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) * 0.5;
}

function isUsableQuad(corners) {
  if (!corners || corners.length !== 4) {
    return false;
  }
  const area = quadArea(corners);
  if (!Number.isFinite(area) || area < 0.01) {
    return false;
  }
  for (let i = 0; i < corners.length; i += 1) {
    for (let j = i + 1; j < corners.length; j += 1) {
      const dx = corners[i][0] - corners[j][0];
      const dy = corners[i][1] - corners[j][1];
      if (dx * dx + dy * dy < 0.0004) {
        return false;
      }
    }
  }
  // Reject non-convex quads.  When the model misses a corner (e.g. on a
  // portrait camera where one corner is out of frame), it often returns 3
  // nearly-collinear points on one edge and one outlier.  That produces a
  // concave quad where one interior angle is reflex — the cross product at
  // that vertex has the opposite sign to the other three.
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < 4; i += 1) {
    const prev = corners[(i + 3) % 4];
    const curr = corners[i];
    const next = corners[(i + 1) % 4];
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) -
      (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross > 0) pos += 1;
    if (cross < 0) neg += 1;
  }
  if (pos > 0 && neg > 0) {
    return false;
  }
  return true;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);

  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-10) {
      throw new Error("Could not solve dewarp transform.");
    }
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
    }
    const scale = a[col][col];
    for (let k = col; k <= size; k += 1) {
      a[col][k] /= scale;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col];
      for (let k = col; k <= size; k += 1) {
        a[row][k] -= factor * a[col][k];
      }
    }
  }

  return a.map((row) => row[size]);
}

function computeHomography(srcPoints, dstPoints) {
  const matrix = [];
  const vector = [];

  for (let i = 0; i < 4; i += 1) {
    const [x, y] = srcPoints[i];
    const [u, v] = dstPoints[i];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }

  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(
    matrix,
    vector,
  );
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function applyHomography(matrix, x, y) {
  const denom = matrix[6] * x + matrix[7] * y + matrix[8];
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / denom,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / denom,
  ];
}

function sampleBilinear(data, width, height, x, y, channel) {
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const i00 = (y0 * width + x0) * 4 + channel;
  const i10 = (y0 * width + x1) * 4 + channel;
  const i01 = (y1 * width + x0) * 4 + channel;
  const i11 = (y1 * width + x1) * 4 + channel;

  const top = data[i00] * (1 - tx) + data[i10] * tx;
  const bottom = data[i01] * (1 - tx) + data[i11] * tx;
  return top * (1 - ty) + bottom * ty;
}

function normalizeEmbedding(embedding) {
  let norm = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-8) {
    for (let i = 0; i < embedding.length; i += 1) {
      embedding[i] /= norm;
    }
  }
  return embedding;
}

function float16ToFloat32(value) {
  const sign = (value & 0x8000) >> 15;
  const exponent = (value & 0x7c00) >> 10;
  const fraction = value & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign ? -0 : 0;
    }
    return (sign ? -1 : 1) * 2 ** -14 * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    return fraction ? Number.NaN : sign ? -Infinity : Infinity;
  }

  return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function createFloat16LookupTable() {
  const table = new Float32Array(65536);
  for (let value = 0; value < table.length; value += 1) {
    table[value] = float16ToFloat32(value);
  }
  return table;
}

const FLOAT16_LOOKUP = createFloat16LookupTable();

function wrapFloat16Buffer(buffer) {
  return new Uint16Array(buffer);
}

export {
  sigmoid,
  orderCorners,
  quadArea,
  isUsableQuad,
  computeHomography,
  applyHomography,
  sampleBilinear,
  normalizeEmbedding,
  FLOAT16_LOOKUP,
};
