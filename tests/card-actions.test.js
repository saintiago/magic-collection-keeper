import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionWheelLayout,
  actionWheelHit,
  rankActionTags,
  boundedArtwork,
  artworkOpening,
  enlargedArtwork,
  wheelPickupSize,
} from "../public/card-action-layout.js";

test("UC-CARD-ACTIONS fixed wheel geometry stays inside phone edges and every visible target matches its drop sector", () => {
  const tags = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    label: `Tag ${i}`,
  }));
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1280, height: 720 },
    { width: 768, height: 1024 },
  ])
    for (const point of [
      { x: 0, y: 0 },
      { x: viewport.width, y: viewport.height },
    ]) {
      const layout = actionWheelLayout(tags, point, viewport),
        before = JSON.stringify(layout);
      assert.ok(layout.targets.length >= 3 && layout.targets.length <= 10);
      assert.equal(layout.targets.at(-1).tag.more, true);
      for (const target of layout.targets) {
        assert.equal(actionWheelHit(layout, target), target);
        assert.ok(
          target.x - target.width / 2 >= 8 &&
            target.x + target.width / 2 <= viewport.width - 8,
        );
        assert.ok(
          target.y - target.height / 2 >= 8 &&
            target.y + target.height / 2 <= viewport.height - 8,
        );
      }
      assert.equal(actionWheelHit(layout, layout.center), null);
      assert.equal(actionWheelHit(layout, { x: -100, y: -100 }), null);
      assert.equal(JSON.stringify(layout), before);
    }
});

test("UC-CARD-WHEEL annular sectors select throughout their wedge, preserve an open center and cancel outside", () => {
  const tags = Array.from({ length: 8 }, (_, i) => ({
    id: String(i),
    label: `Tag ${i}`,
  }));
  const layout = actionWheelLayout(
    tags,
    { x: 540, y: 400 },
    { width: 1080, height: 800, cardHeight: 354 },
  );
  assert.ok(layout.innerRadius * 2 > 354);
  for (const target of layout.targets) {
    for (const fraction of [-0.85, 0, 0.85]) {
      const angle = target.angle + (Math.PI / target.count) * fraction;
      const radius =
        layout.innerRadius + (layout.radius - layout.innerRadius) * 0.8;
      assert.equal(
        actionWheelHit(layout, {
          x: layout.center.x + Math.cos(angle) * radius,
          y: layout.center.y + Math.sin(angle) * radius,
        }),
        target,
      );
    }
  }
  assert.equal(actionWheelHit(layout, layout.center), null);
  assert.equal(
    actionWheelHit(layout, {
      x: layout.center.x + layout.radius + 1,
      y: layout.center.y,
    }),
    null,
  );
  const small = actionWheelLayout(
    tags,
    { x: 160, y: 250 },
    { width: 320, height: 568, cardHeight: 202 },
  );
  const phone = actionWheelLayout(
    tags,
    { x: 195, y: 270 },
    { width: 390, height: 844, cardHeight: 251 },
  );
  assert.ok(
    small.innerRadius / small.radius < phone.innerRadius / phone.radius,
  );
  assert.ok(
    phone.innerRadius / phone.radius < layout.innerRadius / layout.radius,
  );
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

test("UC-CARD-ART safe-area fitting preserves full portrait and minimum dismissal gutters", () => {
  const card = { x: 0, y: 0, width: 180, height: 251 };
  const phone = artworkOpening(card, { width: 390, height: 844 });
  assert.equal(phone.zoom, 1.9);
  const landscape = artworkOpening(card, {
    width: 844,
    height: 390,
    safeLeft: 44,
    safeRight: 44,
    safeBottom: 21,
  });
  assert.equal(landscape.gutterX, 68);
  assert.equal(landscape.gutterY, 53);
  assert.equal(landscape.zoom * card.height, 284);
  const tiny = artworkOpening(
    { width: 300, height: 418 },
    { width: 320, height: 390 },
  );
  assert.ok(tiny.zoom < 1);
  assert.equal(
    boundedArtwork({
      ...card,
      baseWidth: 300,
      baseHeight: 418,
      width: 272,
      height: 326,
      zoom: tiny.zoom,
      minZoom: tiny.zoom,
      x: 999,
      y: 999,
    }).zoom,
    tiny.zoom,
  );
  const hover = enlargedArtwork(card, 2, { width: 320, height: 390 });
  assert.equal(hover.height, 358);
  assert.equal(hover.y, 16);
});

test("UC-CARD-WHEEL centered pickup keeps labels clear without changing ghost or hit geometry", () => {
  for (const width of [320, 390, 1080]) {
    const bounds = {
      width: width < 700 ? 180 : 254,
      height: width < 700 ? 251 : 354,
    };
    const layout = actionWheelLayout(
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        label: `Label ${i}`,
      })),
      { x: 40, y: 220 },
      { width, height: 800, cardHeight: bounds.height },
    );
    const before = JSON.stringify(layout);
    const pickup = wheelPickupSize(layout, bounds);
    assert.ok(pickup.scale <= 1 && pickup.scale > 0.5);
    for (const target of layout.targets) {
      const dx =
        Math.abs(target.x - layout.center.x) -
        (pickup.width + target.width) / 2;
      const dy =
        Math.abs(target.y - layout.center.y) -
        (pickup.height + target.height) / 2;
      assert.ok(dx >= 7.99 || dy >= 7.99);
    }
    assert.equal(JSON.stringify(layout), before);
    assert.ok(
      Math.abs(pickup.width / pickup.height - bounds.width / bounds.height) <
        1e-12,
    );
  }
});
