// SPDX-License-Identifier: AGPL-3.0-only
import { FLOAT16_LOOKUP } from "./collectorvision-math.js";
export function searchVisualCatalog(query, embeddings, records, dims = 128) {
  const matches = [],
    scores = new Float32Array(records.length);
  for (let row = 0; row < records.length; row++) {
    let score = 0;
    const offset = row * dims;
    for (let col = 0; col < dims; col++)
      score += FLOAT16_LOOKUP[embeddings[offset + col]] * query[col];
    scores[row] = score;
    if (matches.length < 5 || score > matches.at(-1).score) {
      matches.push({ row, score });
      matches.sort((a, b) => b.score - a.score);
      if (matches.length > 5) matches.pop();
    }
  }
  if (!matches.length) return { matches, differentIdentityScore: 1 };
  const identity = records[matches[0].row].oracle_id;
  let other = -1;
  for (let row = 0; row < records.length; row++)
    if (records[row].oracle_id !== identity)
      other = Math.max(other, scores[row]);
  return { matches, differentIdentityScore: other };
}
