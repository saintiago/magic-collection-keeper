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

test("SCAN-03 appearance changes, foil-like glare, contrast, blur and detector loss cannot count a stationary card again", () => {
  const gate = createScanAdmission();
  trackUntil(gate, a, 0, 720);
  assert.equal(gate.validate(a, 720, "single"), true);
  const glare = a.map((value, i) =>
    i % 4 === 3 ? 255 : i < a.length / 2 ? 250 : value,
  );
  const contrast = a.map((value, i) =>
    i % 4 === 3 ? 255 : value < 100 ? 85 : 160,
  );
  let time = 900;
  for (const changed of [glare, contrast, b, a]) {
    trackUntil(gate, changed, time, time + 840);
    assert.equal(
      gate.validate(changed, time + 840, "single"),
      false,
      "appearance alone is not physical departure",
    );
    time += 1000;
  }
  // Two no-card measurements during a brief full occlusion/blur are insufficient.
  gate.track(blank, time);
  gate.validate(blank, time, "none");
  gate.track(blank, time + 240);
  gate.validate(blank, time + 240, "none");
  trackUntil(gate, a, time + 360, time + 1200);
  assert.equal(gate.validate(a, time + 1200, "single"), false);
});

test("SCAN-04 only sustained independently checked absence rearms an identical copy; reused/late results and observation gaps do not", () => {
  const gate = createScanAdmission();
  trackUntil(gate, a, 0, 720);
  assert.equal(gate.validate(a, 720, "single"), true);
  trackUntil(gate, blank, 900, 1800);
  gate.validate(blank, 900, "none");
  gate.validate(blank, 1800, "none");
  gate.validate(blank, 1200, "none"); // out of order
  for (let n = 0; n < 10; n++) gate.validate(blank, 1800, "none");
  trackUntil(gate, a, 1920, 2760);
  assert.equal(
    gate.validate(a, 2760, "single"),
    false,
    "only two actual measurements",
  );
  gate.track(blank, 3000);
  gate.validate(blank, 3000, "none");
  gate.track(blank, 3300);
  gate.validate(blank, 3300, "none");
  gate.track(blank, 4200); // unobserved camera pause
  gate.validate(blank, 4200, "none");
  trackUntil(gate, a, 4320, 5160);
  assert.equal(
    gate.validate(a, 5160, "single"),
    false,
    "sampling gap is not departure evidence",
  );
  for (let time = 5400; time <= 6120; time += 120) {
    gate.track(blank, time);
    gate.validate(blank, time, "none");
  }
  trackUntil(gate, a, 6240, 7080);
  assert.equal(
    gate.validate(a, 7080, "single"),
    true,
    "real observed empty interval permits same printing again",
  );
  assert.equal(
    gate.validate(a, 6960, "single"),
    false,
    "late geometry after accepted copy",
  );
});
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
  for (let time = 2800; time <= 3520; time += 120) {
    gate.track(blank, time);
    gate.validate(blank, time, "none");
  }
  trackUntil(gate, a, 3640, 4360);
  assert.equal(gate.validate(a, 4360, "single"), true);
  trackUntil(gate, b, 4500, 5340);
  assert.equal(gate.validate(b, 5340, "ambiguous"), false);
  trackUntil(gate, b, 5460, 6180);
  assert.equal(
    gate.validate(b, 6180, "single"),
    false,
    "ambiguity cannot establish departure",
  );
});
