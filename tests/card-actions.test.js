import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionWheelLayout,
  actionWheelHit,
  rankActionTags,
  boundedArtwork,
} from "../public/card-action-layout.js";

test("UC-CARD-ACTIONS fixed wheel geometry stays inside phone edges and every visible target matches its drop sector", () => {
  const tags = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    label: `Tag ${i}`,
  }));
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1280, height: 720 },
  ])
    for (const point of [
      { x: 0, y: 0 },
      { x: viewport.width, y: viewport.height },
    ]) {
      const layout = actionWheelLayout(tags, point, viewport),
        before = JSON.stringify(layout);
      assert.equal(layout.targets.length, 10);
      assert.equal(layout.targets.at(-1).tag.more, true);
      for (const target of layout.targets) {
        assert.equal(actionWheelHit(layout, target), target);
        assert.ok(target.x >= 8 && target.x <= viewport.width - 8);
        assert.ok(target.y >= 8 && target.y <= viewport.height - 8);
      }
      assert.equal(actionWheelHit(layout, layout.center), null);
      assert.equal(actionWheelHit(layout, { x: -100, y: -100 }), null);
      assert.equal(JSON.stringify(layout), before);
    }
});
test("UC-CARD-ACTIONS recency and relevance affect the next wheel only; artwork pan remains bounded across zoom changes", () => {
  const tags = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
    { id: "system:import-pending", label: "Internal" },
  ];
  assert.deepEqual(
    rankActionTags(tags, ["c"], ["b"]).map((t) => t.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    rankActionTags(tags, [], []).map((t) => t.id),
    ["a", "b", "c"],
  );
  const large = boundedArtwork({
    width: 390,
    height: 650,
    baseWidth: 200,
    baseHeight: 280,
    zoom: 3,
    x: 9999,
    y: -9999,
  });
  assert.equal(large.x, 105);
  assert.equal(large.y, -95);
  const small = boundedArtwork({
    width: 390,
    height: 650,
    baseWidth: 200,
    baseHeight: 280,
    zoom: 1,
    x: 105,
    y: -95,
  });
  assert.equal(small.x, 0);
  assert.equal(small.y, 0);
});
