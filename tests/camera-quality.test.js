import test from "node:test";
import assert from "node:assert/strict";
import {
  improveCamera,
  cameraDiagnostics,
  startCamera,
  capture,
} from "../public/camera.js";
import { createFrameBurst, frameQuality } from "../public/camera-quality.js";

test("camera optional controls preserve constraints and survive unsupported/rejected capabilities", async () => {
  assert.deepEqual(await improveCamera({}), []);
  const calls = [];
  const track = {
    getCapabilities: () => ({
      focusMode: ["continuous"],
      exposureMode: ["continuous"],
      whiteBalanceMode: ["manual"],
    }),
    getConstraints: () => ({ width: { ideal: 1920 } }),
    applyConstraints: async (value) => {
      calls.push(value);
      if (value.advanced.at(-1).focusMode)
        throw new DOMException("Unsupported", "OverconstrainedError");
    },
    getSettings: () => ({
      width: 1280,
      height: 720,
      deviceId: "private",
      groupId: "private",
      label: "private",
      facingMode: "environment",
      focusMode: "continuous",
    }),
  };
  assert.deepEqual(await improveCamera(track), ["exposureMode"]);
  assert.deepEqual(calls[1], {
    width: { ideal: 1920 },
    advanced: [{ exposureMode: "continuous" }],
  });
  const diagnostics = cameraDiagnostics(track);
  assert.equal(diagnostics.actual.width, 1280);
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
});

test("late permission from a canceled camera cannot replace the new session", async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let finish,
    stopped = 0;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () =>
        new Promise((r) => {
          finish = r;
        }),
    },
  });
  const video = { srcObject: null, play: async () => {} },
    controller = new AbortController();
  try {
    const pending = startCamera(video, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    const next = { current: true };
    video.srcObject = next;
    finish({ getTracks: () => [{ stop: () => stopped++ }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopped, 1);
    assert.equal(video.srcObject, next);
  } finally {
    if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
    else delete navigator.mediaDevices;
  }
});

test("bounded frame selection prefers sharp exposed frames and excludes departures and stale frames", () => {
  const burst = createFrameBurst(),
    a = new Uint8ClampedArray([20, 20, 20, 255, 200, 200, 200, 255]),
    b = new Uint8ClampedArray([200, 200, 200, 255, 20, 20, 20, 255]);
  burst.observe("sharp", a, 0, 10);
  burst.observe("soft", a, 120, 2);
  burst.observe("latest", a, 240, 4);
  assert.equal(burst.take(), "sharp");
  burst.observe("previous card", a, 0, 100);
  burst.observe("next card", b, 120, 2);
  assert.equal(burst.take(), "next card");
  burst.observe("stale", a, 0, 100);
  burst.observe("fresh", a, 400, 1);
  assert.equal(burst.take(), "fresh");
  const pixels = (contrast) => ({
    width: 16,
    height: 16,
    data: Uint8ClampedArray.from({ length: 1024 }, (_, i) =>
      i % 4 === 3
        ? 255
        : Math.floor(i / 4) % 2
          ? 128 + contrast
          : 128 - contrast,
    ),
  });
  assert.ok(frameQuality(pixels(60)) > frameQuality(pixels(3)));
  assert.equal(frameQuality(pixels(127)), 0);
});

test("guide capture maps object-fit cover into native pixels and clips off-screen edges", () => {
  let argumentsUsed;
  const prior = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        drawImage: (...args) => {
          argumentsUsed = args;
        },
      }),
    }),
  };
  try {
    const video = {
      videoWidth: 1920,
      videoHeight: 1080,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 600,
      }),
    };
    const guide = {
      getBoundingClientRect: () => ({
        left: 50,
        top: 100,
        width: 300,
        height: 400,
      }),
    };
    const result = capture(video, guide);
    assert.equal(result.width, 540);
    assert.equal(result.height, 720);
    const large = capture(
      { ...video, videoWidth: 7680, videoHeight: 4320 },
      guide,
    );
    assert.ok(large.width * large.height <= 4000000);
    assert.ok(Math.abs(large.width / large.height - 3 / 4) < 0.001);
    assert.ok(argumentsUsed[3] > large.width);
    capture(video, guide);
    assert.ok(Math.abs(argumentsUsed[1] - 690) < 0.001);
    assert.ok(Math.abs(argumentsUsed[2] - 180) < 0.001);
    assert.throws(
      () => capture({ ...video, videoWidth: 0 }, guide),
      /not ready/,
    );
  } finally {
    globalThis.document = prior;
  }
});
