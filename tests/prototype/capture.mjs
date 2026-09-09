import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const mode = process.argv[2] || "hover";
const scene = mode.replace(/-webgl$/, "");
const root = resolve(process.argv[3] || "data/prototype-captures");
const viewport = scene.endsWith("small")
  ? { width: 320, height: 568 }
  : scene === "drag-tablet"
    ? { width: 768, height: 1024 }
    : scene.endsWith("landscape")
      ? { width: 844, height: 390 }
      : mode.includes("phone")
        ? { width: 390, height: 844 }
        : { width: 1080, height: 800 };
const touchInput =
  scene.startsWith("phone") ||
  scene === "drag-phone" ||
  scene.endsWith("small");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport,
  hasTouch: touchInput,
  isMobile: touchInput,
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [],
  writes = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (request.method() !== "GET") writes.push(request.url());
});
await page.addInitScript(() => {
  const dots = new Map();
  const show = (event) => {
    let dot = dots.get(event.pointerId);
    if (!dot) {
      dot = document.createElement("div");
      dot.style.cssText =
        "position:fixed;width:12px;height:12px;border:1.5px solid white;border-radius:50%;background:#bc98484d;box-shadow:0 0 0 1px #182c20;pointer-events:none;z-index:99";
      dots.set(event.pointerId, dot);
    }
    const parent =
      document.querySelector(".artwork-viewer[open]") || document.body;
    if (dot.parentElement !== parent) parent.append(dot);
    dot.style.left = event.clientX - 6 + "px";
    dot.style.top = event.clientY - 6 + "px";
  };
  document.addEventListener("pointermove", show, true);
  document.addEventListener("pointerdown", show, true);
  document.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType === "touch") {
        dots.get(e.pointerId)?.remove();
        dots.delete(e.pointerId);
      }
    },
    true,
  );
});
const query = new URLSearchParams();
if (mode.endsWith("-webgl")) query.set("renderer", "webgl");
if (process.argv[4] === "animation-module")
  query.set("card", "animation-module");
await page.goto("http://127.0.0.1:3120/?" + query);
await page.evaluate(() => document.fonts.ready);
const tile = page.locator("#grid .card-open").nth(touchInput ? 0 : 1);
await tile.waitFor();
await tile.scrollIntoViewIfNeeded();
await page.waitForFunction(
  () => document.querySelector("#grid img")?.naturalWidth > 0,
);
const base = await tile.boundingBox();
await page.mouse.move(8, 88);
const cdp = await context.newCDPSession(page);
const captured = [];
cdp.on("Page.screencastFrame", (event) => {
  captured.push({
    data: Buffer.from(event.data, "base64"),
    time: event.metadata.timestamp,
  });
  cdp
    .send("Page.screencastFrameAck", { sessionId: event.sessionId })
    .catch(() => {});
});
await page.evaluate(() => {
  window.motionFrames = [];
  window.captureMotion = true;
  const next = (time) => {
    if (!window.captureMotion) return;
    const hover = document.querySelector(".artwork-hover:not([hidden])");
    const inspector = document.querySelector(".artwork-viewer[open]");
    const visual =
      hover?.firstElementChild ||
      inspector?.querySelector(".artwork-open-reveal");
    const r = visual?.getBoundingClientRect();
    const lifted = document.querySelector(".artwork-source-lifted");
    const card = inspector?.querySelector(".artwork-full-image");
    window.motionFrames.push({
      time,
      phase: hover
        ? "hover"
        : inspector
          ? "inspector"
          : document.querySelector(".card-action-layer:not([hidden])")
            ? "wheel"
            : "rest",
      x: r?.x,
      y: r?.y,
      width: r?.width,
      height: r?.height,
      sourceOpacity: lifted ? getComputedStyle(lifted).opacity : null,
      opacity: visual ? getComputedStyle(visual).opacity : null,
      tilt: hover
        ? hover.querySelector(".artwork-hover-visual").style.transform
        : inspector
          ? getComputedStyle(
              inspector.querySelector(".artwork-open-orientation"),
            ).transform
          : null,
      infoOpacity: inspector
        ? getComputedStyle(inspector.querySelector(".artwork-details")).opacity
        : null,
      imageWidth: card?.getBoundingClientRect().width,
    });
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
});
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 88,
  maxWidth: 1080,
  maxHeight: 1200,
  everyNthFrame: 1,
});
await mkdir(root, { recursive: true });
const touch = (type, points) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map(([x, y], id) => ({
      x,
      y,
      id,
      radiusX: 3,
      radiusY: 3,
      force: 1,
    })),
  });
const pause = (ms) => page.waitForTimeout(ms);
const evidence = {
  mode,
  viewport,
  source: base,
  errors,
  writes,
  physicalDeviceVerified: false,
  realBrowserFrames: true,
  interpolation: false,
  performanceOrigin: await page.evaluate(() => performance.timeOrigin),
};
await pause(700);
if (mode.startsWith("controls")) {
  await tile.click();
  await pause(650);
  for (const [name, selector] of [
    ["save", ".artwork-save"],
    ["edit", '[data-artwork="edit"]'],
    ["details", '[data-artwork="details"]'],
  ]) {
    const b = await page.locator(selector).boundingBox();
    await page.mouse.move(b.x + 5, b.y + 5, { steps: 12 });
    await pause(180);
    await page.screenshot({
      path: root + "/" + mode + "-" + name + "-left.png",
    });
    await page.mouse.move(b.x + b.width - 5, b.y + b.height - 5, { steps: 20 });
    await pause(180);
    await page.screenshot({
      path: root + "/" + mode + "-" + name + "-right.png",
    });
  }
  const reset = await page
    .getByLabel("Reset zoom", { exact: true })
    .boundingBox();
  await page.mouse.move(reset.x + reset.width / 2, reset.y + reset.height / 2, {
    steps: 10,
  });
  await page.mouse.down();
  await pause(130);
  await page.screenshot({ path: root + "/" + mode + "-pressed.png" });
  await page.mouse.up();
  await pause(450);
  await page.mouse.move(12, 88, { steps: 10 });
  await pause(200);
  await page.screenshot({ path: root + "/" + mode + ".png" });
  await page.keyboard.press("Escape");
  await pause(250);
} else if (mode === "hover") {
  await page.mouse.move(base.x + base.width / 2, base.y + base.height / 2);
  await page.locator(".artwork-hover").waitFor({ state: "visible" });
  await pause(550);
  const preview = await page.locator(".artwork-hover").boundingBox();
  evidence.preview = preview;
  for (const [x, y] of [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.7, 0.7],
    [0.3, 0.7],
    [0.5, 0.5],
  ]) {
    await page.mouse.move(
      preview.x + preview.width * x,
      preview.y + preview.height * y,
      { steps: 10 },
    );
    await pause(180);
  }
  await page.screenshot({ path: root + "/hover.png" });
  await page.mouse.click(
    preview.x + preview.width / 2,
    preview.y + preview.height / 2,
  );
  await pause(1100);
  await page.screenshot({ path: root + "/inspector-desktop.png" });
  await page.getByLabel("Close artwork").click();
  await pause(250);
  await page.mouse.move(base.x + base.width / 2, base.y + base.height / 2);
  await pause(70);
  await page.mouse.move(4, 88);
  await pause(350);
} else if (scene.startsWith("phone")) {
  await tile.tap();
  await pause(1000);
  evidence.image = await page.locator(".artwork-full-image").boundingBox();
  await page.screenshot({ path: root + "/" + mode + ".png" });
  if (mode !== "phone") {
    await page.touchscreen.tap(12, viewport.height / 2);
    evidence.outsideDismissed = !(await page
      .locator(".artwork-viewer")
      .isVisible());
    await pause(400);
  } else {
    await touch("touchStart", [
      [170, 560],
      [225, 650],
    ]);
    for (let i = 1; i <= 32; i++) {
      await touch("touchMove", [
        [170 - i, 560 - i],
        [225 + i, 650 + i],
      ]);
      await pause(1);
    }
    await touch("touchEnd", []);
    await pause(400);
    await touch("touchStart", [[190, 700]]);
    for (let i = 1; i <= 32; i++) {
      await touch("touchMove", [[190 - i, 700 - i * 4.5]]);
      await pause(1);
    }
    await touch("touchEnd", []);
    await pause(500);
    await page.getByRole("button", { name: "Reset zoom" }).tap();
    await pause(700);
    await page.getByLabel("Close artwork").tap();
    await pause(350);
  }
} else {
  const x = base.x + base.width / 2,
    y = base.y + base.height / 2;
  if (touchInput) {
    await touch("touchStart", [[x, y]]);
    await pause(400);
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 12, y);
  }
  await page.locator(".card-action-layer").waitFor({ state: "visible" });
  const targets = await page
    .locator(".card-action-target")
    .evaluateAll((nodes) =>
      nodes.map((el) => ({
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        label: el.getAttribute("title"),
        width: el.offsetWidth,
        height: el.offsetHeight,
      })),
    );
  const center = await page.locator(".card-action-layer").evaluate((el) => ({
    x: parseFloat(el.style.getPropertyValue("--wheel-x")),
    y: parseFloat(el.style.getPropertyValue("--wheel-y")),
    diameter: parseFloat(el.style.getPropertyValue("--wheel-width")),
  }));
  evidence.targets = targets;
  evidence.wheel = center;
  let last = { x, y };
  for (const target of targets
    .slice(2)
    .concat(targets.slice(0, 2))
    .slice(0, 5)) {
    const steps = touchInput ? 24 : 32;
    for (let i = 1; i <= steps; i++) {
      const point = [
        last.x + ((target.x - last.x) * i) / steps,
        last.y + ((target.y - last.y) * i) / steps,
      ];
      if (touchInput) await touch("touchMove", [point]);
      else await page.mouse.move(...point);
      await pause(1);
    }
    last = target;
    await pause(330);
  }
  await page.screenshot({ path: root + "/" + mode + ".png" });
  await page.keyboard.press("Escape");
  if (touchInput) await touch("touchEnd", []);
  else await page.mouse.up();
  await pause(450);
}
await pause(250);
const finalFrame = await cdp.send("Page.captureScreenshot", {
  format: "jpeg",
  quality: 88,
});
captured.push({
  data: Buffer.from(finalFrame.data, "base64"),
  time: Date.now() / 1000,
});
await cdp.send("Page.stopScreencast");
const motion = await page.evaluate(() => {
  window.captureMotion = false;
  return window.motionFrames;
});
evidence.renderer = await page.evaluate(
  () => window.prototypeRenderer || { renderer: "svg" },
);
await context.close();
await browser.close();
if (errors.length || writes.length)
  throw Error(JSON.stringify({ errors, writes }));
const frames = captured.filter(
  (frame, i) => !i || frame.time > captured[i - 1].time,
);
const raw = root + "/" + mode + "-frames";
await mkdir(raw, { recursive: true });
const concat = [];
for (let i = 0; i < frames.length; i++) {
  const name = `${String(i).padStart(5, "0")}.jpg`;
  await writeFile(raw + "/" + name, frames[i].data);
  concat.push(
    `file '${name}'`,
    "option framerate 1000",
    `duration ${i < frames.length - 1 ? frames[i + 1].time - frames[i].time : 0.1}`,
  );
}
await writeFile(raw + "/frames.txt", concat.join("\n"));
execFileSync(
  process.env.FFMPEG_PATH || "ffmpeg",
  [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    raw + "/frames.txt",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "19",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-video_track_timescale",
    "1000",
    "-an",
    root + "/" + mode + ".mp4",
  ],
  { stdio: "ignore" },
);
const deltas = frames
  .slice(1)
  .map((frame, i) => (frame.time - frames[i].time) * 1000);
const motionDeltas = deltas.filter((dt) => dt < 100);
const quantile = (values, q) =>
  values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
Object.assign(evidence, {
  file: root + "/" + mode + ".mp4",
  capturedFrames: frames.length,
  durationSeconds: frames.at(-1).time - frames[0].time,
  changedFrameIntervalMedianMs: quantile(motionDeltas, 0.5),
  changedFrameIntervalP95Ms: quantile(motionDeltas, 0.95),
  captureTimestamps: frames.map((frame) => frame.time),
  motionFrames: motion,
});
await writeFile(root + "/" + mode + ".json", JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify({
    ...evidence,
    captureTimestamps: undefined,
    motionFrames: undefined,
  }),
);
