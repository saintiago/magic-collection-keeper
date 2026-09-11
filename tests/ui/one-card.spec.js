import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.js";
test.use({ realCardPresence: true });

test("UC-ONE-CARD actual geometry waits quietly through overlap and preserves outgoing-card suppression", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Windows WebKit has no canvas captureStream; actual photo geometry is covered separately.",
  );
  test.setTimeout(60000);
  const photo =
    "data:image/jpeg;base64," +
    (await readFile("recognition/artifacts/public-card.jpg")).toString(
      "base64",
    );
  const nextPhoto =
    "data:image/jpeg;base64," +
    (await readFile("recognition/fixtures/bolt.jpg")).toString("base64");
  await page.route("**/browser-recognition.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `export function createBrowserRecognition(){return {kind:"browser-onnx",prepare:async()=>({}),dispose(){},async recognize(){const next=window.oneCardScene==="next";const card={id:next?"33333333-3333-4333-8333-333333333333":"11111111-1111-4111-8111-111111111111",oracle_id:next?"44444444-4444-4444-8444-444444444444":"22222222-2222-4222-8222-222222222222",name:next?"Controlled B":"Controlled A",finishes:["nonfoil"]};return {name:card.name,status:"possible",candidates:[card],selected:card,suggested:true,finish:"nonfoil"};}}}`,
    }),
  );
  await page.addInitScript(
    async ({ photo, nextPhoto }) => {
      window.captureEvents = [];
      window.overlayMetrics = [];
      window.addEventListener("keeper-scan-measurement", (event) =>
        window.captureEvents.push(event.detail),
      );
      window.addEventListener("keeper-overlay-measurement", (event) =>
        window.overlayMetrics.push(event.detail),
      );
      navigator.mediaDevices.getUserMedia = async () => {
        const image = new Image();
        image.src = photo;
        await image.decode();
        const next = new Image();
        next.src = nextPhoto;
        await next.decode();
        const bounds = document
            .querySelector("#camera-video")
            .getBoundingClientRect(),
          guide = document.querySelector("#scan-guide").getBoundingClientRect();
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bounds.width * 2);
        canvas.height = Math.round(bounds.height * 2);
        const ctx = canvas.getContext("2d");
        window.paintScene = (kind) => {
          window.oneCardScene = kind;
          const sample = document.createElement("canvas");
          sample.width = 800;
          sample.height = 1120;
          const c = sample.getContext("2d");
          c.fillStyle = "white";
          c.fillRect(0, 0, 800, 1120);
          if (kind === "single") c.drawImage(image, 210, 260, 380, 530);
          if (kind === "next") c.drawImage(next, 210, 260, 380, 530);
          if (kind === "two") {
            c.drawImage(image, 0, 260, 380, 530);
            c.drawImage(image, 400, 260, 380, 530);
          }
          if (kind === "overlap") {
            c.drawImage(image, 80, 100, 570, 800);
            c.drawImage(image, 150, 430, 570, 800);
          }
          ctx.fillStyle = "#888";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(
            sample,
            (guide.left - bounds.left) * 2,
            (guide.top - bounds.top) * 2,
            guide.width * 2,
            guide.height * 2,
          );
        };
        window.paintScene("two");
        return canvas.captureStream(15);
      };
    },
    { photo, nextPhoto },
  );
  await page.goto("/#collection");
  await page.locator("#scan").click();
  await page.locator("#camera-start").click();
  await expect(page.locator("#scan-status")).toHaveText(
    "Wait until only one card is visible.",
    { timeout: 15000 },
  );
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.captureEvents.length)).toBe(0);
  await page.evaluate(() => window.paintScene("single"));
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies", {
    timeout: 10000,
  });
  await page.evaluate(() => window.paintScene("overlap"));
  await expect(page.locator("#scan-status")).toHaveText(
    "Wait until only one card is visible.",
  );
  await page.evaluate(() => window.paintScene("single"));
  await page.waitForTimeout(1500);
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await expect(page.locator("#scan-status")).not.toHaveText(
    "Wait until only one card is visible.",
  );
  await page.evaluate(() => {
    window.geometryMeasurements.length = 0;
    window.paintScene("blank");
  });
  await expect(page.locator("#scan-status")).toHaveText(
    "Place one card inside the guide.",
  );
  // A fixed 500ms pause can end before the second empty-frame result on a
  // slower runner. Keep this controlled scene until multiple current-scene
  // observations have arrived, leaving the production departure gate intact.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const frames = window.geometryMeasurements.filter(
            (frame) => frame.state === "none" && frame.sameScene,
          );
          return (
            frames.length >= 3 &&
            frames.at(-1).capturedAt - frames[0].capturedAt >= 600
          );
        }),
      { timeout: 10000 },
    )
    .toBe(true);
  await page.evaluate(() => window.paintScene("single"));
  await expect(page.locator("#scan-status")).toContainText("Same card ignored");
  await expect(page.locator("#scan-count")).toHaveText("1 queued · 1 copies");
  await page.evaluate(() => window.paintScene("next"));
  await expect(page.locator("#scan-count")).toHaveText("2 queued · 2 copies", {
    timeout: 15000,
  });
  await page.waitForTimeout(1800);
  await expect(page.locator("#scan-count")).toHaveText("2 queued · 2 copies");
  await page.evaluate(() => window.paintScene("single"));
  await expect(page.locator("#scan-count")).toHaveText("3 queued · 3 copies", {
    timeout: 15000,
  });
  expect(
    await page.evaluate(
      () => window.captureEvents.filter((r) => r.outcome === "selected").length,
    ),
  ).toBe(3);
  await expect(page.locator("#scan-overlay")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.screenshot({
    path: test.info().outputPath("one-card-overlay.png"),
  });
  await page.locator("#scan-back").click();
  const [metrics] = await page.evaluate(() => window.overlayMetrics);
  expect(metrics.frames).toBeGreaterThan(20);
  expect(metrics.meanDrawMs).toBeLessThan(5);
  await test.info().attach("overlay-draw-metrics", {
    body: JSON.stringify(metrics),
    contentType: "application/json",
  });
});

test("UC-OVERLAY actual stages, departure, resize and reduced motion never display stale activity", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#collection");
  const result = await page.evaluate(async () => {
    const { createScanOverlay } = await import("/scan-overlay.js");
    const canvas = document.createElement("canvas"),
      video = document.createElement("video"),
      guide = document.createElement("div");
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:320px;height:440px";
    document.body.append(canvas, video, guide);
    Object.defineProperties(video, {
      videoWidth: { value: 720 },
      videoHeight: { value: 1280 },
    });
    video.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 320,
      height: 440,
    });
    guide.getBoundingClientRect = () => ({
      left: 40,
      top: 30,
      width: 240,
      height: 330,
      bottom: 360,
    });
    const ctx = canvas.getContext("2d"),
      labels = [],
      dashes = [];
    const fill = ctx.fillText.bind(ctx),
      dash = ctx.setLineDash.bind(ctx);
    ctx.fillText = (s, ...args) => {
      labels.push(s);
      fill(s, ...args);
    };
    ctx.setLineDash = (s) => {
      dashes.push(s);
      dash(s);
    };
    const overlay = createScanOverlay({ canvas, video, guide }),
      signature = Array(64).fill(40),
      geometry = {
        state: "single",
        regions: [
          [
            [0.1, 0.1],
            [0.9, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
          ],
        ],
      };
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    overlay.observe(geometry, signature);
    overlay.capture("one", signature, geometry);
    overlay.stage("one", { stage: "visual", active: true });
    await frame();
    const visual = labels.at(-1);
    overlay.stage("one", { stage: "visual", active: false });
    overlay.stage("one", { stage: "backend", active: true });
    await frame();
    const backend = labels.at(-1),
      noFakeTitle = dashes.length === 0;
    overlay.recognized("one", "Adaptive Training Post");
    await frame();
    const named = labels.at(-1);
    overlay.observe({ ...geometry, state: "ambiguous" }, Array(64).fill(130));
    overlay.recognized("one", "Stale card");
    overlay.stage("one", { stage: "ocr-title", active: true });
    await frame();
    const departed = labels.at(-1);
    canvas.style.width = "240px";
    await frame();
    const width = canvas.width;
    const metrics = overlay.destroy(),
      count = labels.length;
    await frame();
    const stopped = labels.length === count;
    canvas.remove();
    video.remove();
    guide.remove();
    return {
      visual,
      backend,
      noFakeTitle,
      named,
      departed,
      width,
      ratio: Math.min(2, devicePixelRatio),
      metrics,
      stopped,
    };
  });
  expect(result.visual).toBe("Matching artwork");
  expect(result.backend).toBe("Reading card");
  expect(result.noFakeTitle).toBe(true);
  expect(result.named).toContain("Adaptive Training Post");
  expect(result.departed).toBe("One card at a time");
  expect(result.width).toBe(240 * result.ratio);
  expect(result.stopped).toBe(true);
  expect(result.metrics.meanDrawMs).toBeLessThan(5);
});
