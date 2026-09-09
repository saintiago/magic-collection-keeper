import test from "node:test";
import assert from "node:assert/strict";
import { createTransitionGate } from "../public/scan-transition.js";
import { inspectCardRegions } from "../public/card-regions.js";
import { overlayPoint } from "../public/scan-overlay.js";
const pattern = (shift) =>
  Uint8ClampedArray.from({ length: 24 * 32 * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (Math.floor(i / 4) + shift) % 2 ? 220 : 30,
  );
const a = pattern(0),
  b = pattern(1),
  blank = new Uint8ClampedArray(a.length).fill(128);

test("UC-ONE-CARD overlap cannot rearm the outgoing card; a new stable single and visible empty departure can", () => {
  const gate = createTransitionGate();
  assert.equal(gate.observe(a, 0, "single"), false);
  assert.equal(gate.observe(a, 720, "single"), true);
  for (const t of [900, 1200, 1800])
    assert.equal(gate.observe(b, t, "multiple"), false);
  for (const t of [1900, 2200, 3000])
    assert.equal(gate.observe(a, t, "single"), false);
  assert.equal(gate.observe(b, 3100, "single"), false);
  assert.equal(gate.observe(b, 3400, "single"), false);
  assert.equal(gate.observe(b, 4120, "single"), true);
  assert.equal(gate.observe(b, 5200, "single"), false);
  gate.observe(blank, 5300, "none");
  gate.observe(blank, 5550, "none");
  assert.equal(gate.observe(b, 5700, "single"), false);
  assert.equal(gate.observe(b, 6420, "single"), true);
});
test("UC-ONE-CARD zero to two to one requires fresh stability; uncertain regions cannot capture", () => {
  const gate = createTransitionGate();
  for (const [t, state] of [
    [0, "none"],
    [500, "multiple"],
    [1500, "multiple"],
    [1800, "ambiguous"],
  ])
    assert.equal(gate.observe(a, t, state), false);
  assert.equal(gate.observe(a, 2000, "single"), false);
  assert.equal(gate.observe(a, 2500, "single"), false);
  assert.equal(gate.observe(a, 2720, "single"), true);
});
test("UC-ONE-CARD second independent geometry blocks embedding while blank and uncertain geometry fail closed", async () => {
  const frame = {
    width: 32,
    height: 32,
    data: new Uint8ClampedArray(4096).fill(240),
  };
  const output = (points, sharpness) => [points.flat(), [1], [sharpness]];
  const first = [
      [0.01, 0.1],
      [0.48, 0.1],
      [0.48, 0.9],
      [0.01, 0.9],
    ],
    second = [
      [0.52, 0.1],
      [0.99, 0.1],
      [0.99, 0.9],
      [0.52, 0.9],
    ];
  let calls = 0;
  const multiple = await inspectCardRegions(frame, async (input) => {
    if (calls++) {
      assert.notDeepEqual(input.data, frame.data);
      return output(second, 0.07);
    }
    return output(first, 0.07);
  });
  assert.equal(multiple.state, "multiple");
  assert.equal(multiple.regions.length, 2);
  assert.equal(calls, 2);
  assert.equal(
    (await inspectCardRegions(frame, async () => output(first, 0.008))).state,
    "none",
  );
  calls = 0;
  assert.equal(
    (
      await inspectCardRegions(frame, async () =>
        output(first, calls++ ? 0.008 : 0.04),
      )
    ).state,
    "ambiguous",
  );
});
test("UC-OVERLAY source crop mapping honors cover, nonzero surface offsets, clipping and rotated dimensions", () => {
  const video = { left: 20, top: 30, width: 400, height: 600 },
    guide = { left: 70, top: 130, width: 300, height: 400 },
    surface = { left: 10, top: 20 };
  assert.deepEqual(
    overlayPoint([0, 0], video, guide, surface, 1920, 1080),
    [60, 110],
  );
  assert.deepEqual(
    overlayPoint([1, 1], video, guide, surface, 1080, 1920),
    [360, 510],
  );
  const outside = { left: -100, top: 30, width: 300, height: 600 };
  const mapped = overlayPoint([0, 0], video, outside, surface, 400, 600);
  assert.deepEqual(mapped, [10, 10]);
});
