import test from "node:test";
import assert from "node:assert/strict";
import { searchVisualCatalog } from "../public/visual-search.js";
test("reprints do not hide the competing identity outside the first five matches", () => {
  const records = [
    ...Array.from({ length: 7 }, () => ({ oracle_id: "same-card" })),
    { oracle_id: "competitor" },
  ];
  const embeddings = new Uint16Array([
    ...Array(7).fill([0x3c00, 0]).flat(),
    0x3800,
    0,
  ]);
  const result = searchVisualCatalog(
    new Float32Array([1, 0]),
    embeddings,
    records,
    2,
  );
  assert.equal(result.matches.length, 5);
  assert.equal(result.matches[0].score, 1);
  assert.equal(result.differentIdentityScore, 0.5);
});
test("a strong competing identity remains ambiguity instead of increasing a confidence claim", () => {
  const result = searchVisualCatalog(
    new Float32Array([1, 0]),
    new Uint16Array([0x3c00, 0, 0x3c00, 0]),
    [{ oracle_id: "a" }, { oracle_id: "b" }],
    2,
  );
  assert.equal(result.matches[0].score - result.differentIdentityScore, 0);
});
