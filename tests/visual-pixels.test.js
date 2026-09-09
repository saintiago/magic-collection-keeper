import test from "node:test";
import assert from "node:assert/strict";
import { normalizedPixels, warpPixels } from "../public/visual-pixels.js";

test("portable model pixels preserve RGB planes and rotate physical orientation", () => {
  const frame = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]),
  };
  const upright = normalizedPixels(frame, 2),
    rotated = normalizedPixels(frame, 2, true);
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < 4; i++)
      assert.equal(rotated[c * 4 + i], upright[c * 4 + 3 - i]);
  assert.ok(Math.abs(upright[0] - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs(upright[4] - (0 - 0.456) / 0.224) < 1e-6);
  const middle = normalizedPixels(frame, 1);
  assert.ok(Math.abs(middle[0] - (0.5 - 0.485) / 0.229) < 1e-6);
});

test("dewarping keeps constant image colors through perspective interpolation", () => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([24, 75, 169, 255], i);
  const warped = warpPixels({ width: 4, height: 4, data }, [
    [0.1, 0.1],
    [0.9, 0.2],
    [0.8, 0.9],
    [0.2, 0.8],
  ]);
  for (const i of [0, 10000, warped.data.length - 4])
    assert.deepEqual([...warped.data.slice(i, i + 4)], [24, 75, 169, 255]);
});
