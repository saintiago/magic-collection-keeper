import test from "node:test";
import assert from "node:assert/strict";
import { createScanAdmission } from "../public/scan-admission.js";
const pattern = (shift) =>
  Uint8ClampedArray.from({ length: 768 * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (Math.floor(i / 4) + shift) % 2 ? 220 : 30,
  );
const a = pattern(0),
  b = pattern(1),
  blank = new Uint8ClampedArray(a.length).fill(128);
function trackUntil(gate, frame, from, until) {
  for (let now = from; now < until; now += 120) gate.track(frame, now);
  gate.track(frame, until);
}

test("UC-ONE-CARD measured 600ms setting rejects a 480ms transient and stale checked frames", () => {
  const gate = createScanAdmission();
  gate.track(a, 0);
  gate.track(a, 480);
  assert.equal(gate.validate(a, 480, "single"), false);
  gate.track(b, 600);
  assert.equal(gate.validate(a, 480, "single"), false);
  gate.track(b, 1080);
  assert.equal(gate.validate(b, 1080, "single"), false);
  gate.track(b, 1200);
  assert.equal(gate.validate(b, 1080, "single"), true);
  const slow = createScanAdmission();
  trackUntil(slow, a, 0, 12000);
  assert.equal(
    slow.matches(a, 120),
    true,
    "slow check in continuously observed scene",
  );
  slow.track(a, 12121);
  assert.equal(
    slow.validate(a, 120, "single"),
    false,
    "no stale geometry after twelve seconds even in an unchanged scene",
  );
});
test("UC-ONE-CARD a sampling gap invalidates old geometry and requires fresh stability without rearming the same card", () => {
  const gate = createScanAdmission();
  trackUntil(gate, a, 0, 720);
  gate.track(a, 1320);
  assert.equal(gate.validate(a, 720, "single"), false);
  assert.equal(gate.validate(a, 1320, "single"), false);
  trackUntil(gate, a, 1440, 1920);
  assert.equal(gate.validate(a, 1800, "single"), true);
  gate.track(a, 3000);
  trackUntil(gate, a, 3120, 3720);
  assert.equal(gate.validate(a, 3600, "single"), false);
});
test("UC-ONE-CARD continuous stability is credited before slow geometry without a second hold; stale frames cannot queue", () => {
  const gate = createScanAdmission();
  for (let now = 0; now <= 840; now += 120) gate.track(a, now);
  assert.equal(gate.validate(a, 720, "single"), true);
  assert.equal(gate.validate(a, 840, "single"), false);
  for (let now = 960; now <= 1800; now += 120) gate.track(b, now);
  gate.track(a, 1920);
  assert.equal(
    gate.validate(b, 1800, "single"),
    false,
    "late geometry after departure",
  );
  for (let now = 2040; now <= 3000; now += 120) gate.track(a, now);
  assert.equal(
    gate.validate(a, 3000, "single"),
    false,
    "same outgoing card stays suppressed",
  );
});
test("UC-ONE-CARD rejected overlap never consumes a copy or rearms outgoing card; confirmed empty departure permits identical copy", () => {
  const gate = createScanAdmission();
  trackUntil(gate, a, 0, 720);
  assert.equal(gate.validate(a, 720, "single"), true);
  trackUntil(gate, b, 900, 1700);
  assert.equal(gate.validate(b, 1700, "multiple"), false);
  trackUntil(gate, a, 1800, 2600);
  assert.equal(gate.validate(a, 2600, "single"), false);
  gate.track(blank, 2800);
  gate.validate(blank, 2800, "none");
  gate.track(blank, 3040);
  gate.validate(blank, 3040, "none");
  trackUntil(gate, a, 3200, 3920);
  assert.equal(gate.validate(a, 3920, "single"), true);
  trackUntil(gate, b, 4100, 4820);
  assert.equal(gate.validate(b, 4820, "ambiguous"), false);
  gate.track(b, 4940);
  assert.equal(gate.validate(b, 4940, "single"), false);
  trackUntil(gate, b, 5060, 5540);
  assert.equal(gate.validate(b, 5540, "single"), true);
});
