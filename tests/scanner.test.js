import test from "node:test";
import assert from "node:assert/strict";
import {
  createTransitionGate,
  visualDifference,
} from "../public/scan-transition.js";
import { confidentPrinting } from "../public/scan-resolution.js";
import { createScanAudio } from "../public/scan-audio.js";

const frame = (flip = false, brightness = 0) =>
  Uint8ClampedArray.from({ length: 768 * 4 }, (_, i) =>
    i % 4 === 3
      ? 255
      : (Math.floor(i / 4) % 24 < 12 !== flip ? 40 : 200) + brightness,
  );
test("visual transitions rearm identical cards after departure, but not stationary frames, flicker or short jitter", () => {
  const gate = createTransitionGate(),
    a = frame(),
    b = frame(true),
    blank = new Uint8ClampedArray(a.length).fill(100);
  assert.equal(gate.observe(a, 0), false);
  assert.equal(gate.observe(a, 800), true);
  for (let now = 1000; now <= 3000; now += 200)
    assert.equal(gate.observe(frame(false, 15), now), false);
  assert.equal(visualDifference(a, frame(false, 15)), 0);
  gate.observe(b, 3100);
  gate.observe(a, 3220);
  assert.equal(gate.observe(a, 4100), false);
  gate.observe(blank, 4200);
  gate.observe(blank, 4440);
  assert.equal(
    gate.observe(blank, 5300),
    false,
    "plain background is not a card attempt",
  );
  gate.observe(a, 5500);
  assert.equal(
    gate.observe(a, 6300),
    true,
    "same artwork after actual departure is a new attempt",
  );
  assert.equal(gate.observe(a, 7300), false);
  gate.observe(b, 7500);
  gate.observe(b, 7800);
  assert.equal(gate.observe(b, 8600), true);
});
test("automatic match requires confident agreeing exact printing, name and language", () => {
  const card = {
    name: "Lightning Bolt",
    set: "m11",
    collector_number: "149",
    lang: "en",
  };
  const reading = {
    name: card.name,
    exact: { set: "M11", number: "0149", language: "EN" },
    confidence: 91,
  };
  const data = { cards: [card], hasMore: false };
  assert.equal(confidentPrinting(reading, data), card);
  for (const changed of [
    { confidence: 45 },
    { name: "Lightning Strike" },
    { exact: null },
    { exact: { set: "M11", number: "149", language: "ES" } },
  ])
    assert.equal(confidentPrinting({ ...reading, ...changed }, data), null);
  assert.equal(confidentPrinting(reading, { ...data, hasMore: true }), null);
  assert.equal(confidentPrinting(reading, { cards: [card, card] }), null);
});
test("success and error cues are distinct, once per attempt, muted safely and closed", async () => {
  const notes = [];
  let closed = 0;
  const context = {
    state: "suspended",
    currentTime: 0,
    destination: {},
    async resume() {
      this.state = "running";
    },
    async close() {
      this.state = "closed";
      closed++;
    },
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      return {
        frequency: {},
        connect() {},
        disconnect() {},
        start() {
          notes.push(this.frequency.value);
        },
        stop() {},
      };
    },
  };
  const audio = createScanAudio({ makeContext: () => context });
  assert.equal(await audio.activate(), true);
  audio.cue("success", 1);
  audio.cue("error", 1);
  audio.cue("error", 2);
  assert.deepEqual(notes, [660, 880, 230, 170]);
  audio.setMuted(true);
  audio.cue("error", 3);
  assert.equal(notes.length, 4);
  await audio.close();
  assert.equal(closed, 1);
});
