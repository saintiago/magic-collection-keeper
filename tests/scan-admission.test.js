import test from "node:test";
import assert from "node:assert/strict";
import { createScanAdmission } from "../public/scan-admission.js";
import { createScanSequence } from "../public/scan-sequence.js";
const frame = Uint8ClampedArray.from({ length: 768 * 4 }, (_, i) =>
  i % 4 === 3 ? 255 : Math.floor(i / 4) % 2 ? 220 : 30,
);
const changed = frame.map((v, i) => (i % 4 === 3 ? 255 : 255 - v));
function track(gate, image, from, to) {
  for (let t = from; t <= to; t += 120) gate.track(image, t);
}

test("SCAN-10 stable single-card samples can be read again without artwork or empty departure", () => {
  const gate = createScanAdmission();
  track(gate, frame, 0, 480);
  assert.equal(gate.validate(frame, 480, "single"), false);
  gate.track(frame, 600);
  assert.equal(gate.validate(frame, 600, "single"), true);
  gate.track(frame, 720);
  assert.equal(
    gate.validate(frame, 600, "single"),
    false,
    "same checked sample cannot repeat",
  );
  assert.equal(
    gate.validate(frame, 720, "single"),
    true,
    "fresh sample of same appearance remains readable",
  );
  track(gate, changed, 840, 1440);
  assert.equal(gate.validate(changed, 1440, "single"), true);
});

test("SCAN-10 actual multiple/ambiguous/empty geometry never admits a capture and resets stability", () => {
  for (const state of ["multiple", "ambiguous", "none"]) {
    const gate = createScanAdmission();
    track(gate, frame, 0, 720);
    assert.equal(gate.validate(frame, 720, state), false);
    gate.track(frame, 840);
    assert.equal(gate.validate(frame, 840, "single"), false);
    track(gate, frame, 960, 1440);
    assert.equal(gate.validate(frame, 1440, "single"), true);
  }
});

test("SCAN-10 late geometry, motion and observation gaps require current stable evidence", () => {
  const gate = createScanAdmission();
  track(gate, frame, 0, 720);
  gate.track(changed, 840);
  assert.equal(gate.validate(frame, 720, "single"), false);
  track(gate, changed, 960, 1560);
  assert.equal(gate.validate(changed, 1560, "single"), true);
  gate.track(changed, 2400);
  assert.equal(gate.validate(changed, 1560, "single"), false);
  track(gate, changed, 2520, 3120);
  assert.equal(gate.validate(changed, 3120, "single"), true);
  assert.equal(gate.validate(changed, 3000, "single"), false, "out of order");
});

test("SCAN-10 consecutive Oracle identity suppression gives A,A once and A,B,A three", () => {
  const sequence = createScanSequence();
  const a = { oracle_id: "A", id: "printing-a" },
    b = { oracle_id: "B", id: "printing-b" };
  assert.deepEqual(
    [a, { ...a, id: "other-language-printing" }, b, b, a].map((card) =>
      sequence.accept(card),
    ),
    ["accepted", "duplicate", "accepted", "duplicate", "accepted"],
  );
  assert.equal(sequence.accept({ ...a, finish: "foil" }), "duplicate");
});

test("SCAN-10 unresolved results and mutable/late printing metadata cannot change acceptance history", () => {
  const sequence = createScanSequence(),
    a = { oracle_id: "A", id: "a" };
  assert.equal(sequence.accept(a), "accepted");
  a.oracle_id = "B";
  assert.equal(sequence.accept(null), "unresolved");
  assert.equal(sequence.accept({ id: "a" }), "unresolved");
  assert.equal(sequence.accept({ oracle_id: "A", id: "a2" }), "duplicate");
  assert.equal(sequence.accept({ oracle_id: "B", id: "b" }), "accepted");
  assert.equal(sequence.accept({ oracle_id: "A", id: "a" }), "accepted");
});
