// Actual application with an isolated synthetic 1,000-printing collection.
// Native browser mouse events are automated; this is not physical input latency.
import { chromium, webkit } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const output = process.argv[2] || "data/card-pointer";
const sourceRef = process.argv[3];
if (sourceRef && !/^[a-f0-9]{7,40}$/.test(sourceRef))
  throw Error("Expected commit SHA");
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:3199";
const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: "3199", DB_PATH: ":memory:" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tags = Array.from({ length: 14 }, (_, i) => ({
  id: `perf-tag-${i}`,
  label: `Performance deck ${i} with a readable label`,
  type: "location",
  kind: "deck",
}));
const rows = Array.from({ length: 1000 }, (_, i) => ({
  id: `perf-row-${i}`,
  printing_id: `perf-print-${i}`,
  quantity: 3,
  finish: "nonfoil",
  condition: "NM",
  tag_ids: [],
  tags: [],
  locations: [{ tag_id: tags[0].id, quantity: 1, tag: tags[0] }],
  card: {
    id: `perf-print-${i}`,
    oracle_id: `perf-oracle-${i}`,
    name: `Performance card ${String(i).padStart(4, "0")}`,
    set: "tst",
    set_name: "Isolated performance fixture",
    collector_number: String(i),
    lang: "en",
    color_identity: ["U"],
    type_line: "Artifact Creature",
    image_uris: { normal: `${base}/perf-art.svg?${i % 24}` },
    finishes: ["nonfoil"],
  },
}));
const results = [];
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await sleep(100);
  }
  for (const [engine, driver] of Object.entries({ chromium, webkit })) {
    const browser = await driver.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      if (sourceRef)
        await page.route(/\.(js|css)(\?.*)?$/, (route) => {
          const name = new URL(route.request().url()).pathname.slice(1);
          if (!/^[a-z0-9-]+\.(js|css)$/.test(name)) return route.continue();
          try {
            return route.fulfill({
              body: execFileSync("git", [
                "show",
                `${sourceRef}:public/${name}`,
              ]),
              contentType: name.endsWith(".js")
                ? "text/javascript"
                : "text/css",
            });
          } catch {
            return route.continue();
          }
        });
      await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() !== "GET")
          throw Error("Performance fixture must never write");
        return route.fulfill({
          json:
            path === "/api/collection"
              ? rows
              : path === "/api/tags"
                ? tags
                : { cards: [], total: 0, hasMore: false },
        });
      });
      await page.route("**/catalog/current.json", (route) =>
        route.fulfill({ status: 503, json: { error: "Isolated fixture" } }),
      );
      await page.route("**/perf-art.svg?*", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" rx="24" fill="#13251d"/><rect x="20" y="20" width="448" height="408" rx="15" fill="#7a9b91"/><text x="30" y="475" fill="white" font-size="28">Performance artwork</text></svg>',
        }),
      );
      await page.addInitScript(() => {
        const stats = (window.pointerStats = {
          handler: [],
          rect: [],
          latency: [],
          frames: [],
          gridReplacements: 0,
          pending: 0,
          peak: 0,
          callbacks: 0,
          longTasks: [],
          longTaskSupported:
            PerformanceObserver.supportedEntryTypes?.includes("longtask") ||
            false,
        });
        if (stats.longTaskSupported)
          new PerformanceObserver((list) =>
            stats.longTasks.push(...list.getEntries().map((e) => e.duration)),
          ).observe({ entryTypes: ["longtask"] });
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (
          type,
          listener,
          options,
        ) {
          if (type === "pointermove" && typeof listener === "function") {
            const original = listener;
            listener = function (event) {
              const start = performance.now();
              try {
                return original.call(this, event);
              } finally {
                stats.handler.push(performance.now() - start);
              }
            };
          }
          return add.call(this, type, listener, options);
        };
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function () {
          const start = performance.now();
          const result = rect.call(this);
          stats.rect.push({
            ms: performance.now() - start,
            cls: this.className,
          });
          return result;
        };
        const raf = window.requestAnimationFrame.bind(window),
          cancel = window.cancelAnimationFrame.bind(window),
          ids = new Set();
        window.requestAnimationFrame = (cb) => {
          let id = raf((time) => {
            ids.delete(id);
            stats.pending = ids.size;
            stats.callbacks++;
            cb(time);
          });
          ids.add(id);
          stats.pending = ids.size;
          stats.peak = Math.max(stats.peak, ids.size);
          return id;
        };
        window.cancelAnimationFrame = (id) => {
          ids.delete(id);
          stats.pending = ids.size;
          cancel(id);
        };
        add.call(
          document,
          "pointermove",
          () => {
            const start = performance.now();
            raf(() => stats.latency.push(performance.now() - start));
          },
          { capture: true },
        );
        let last = 0;
        function sample(time) {
          if (last) stats.frames.push(time - last);
          last = time;
          raf(sample);
        }
        raf(sample);
        add.call(window, "DOMContentLoaded", () =>
          new MutationObserver((records) => {
            stats.gridReplacements += records.filter(
              (r) => r.target.id === "grid",
            ).length;
          }).observe(document.body, { childList: true, subtree: true }),
        );
        window.resetPointerStats = () => {
          for (const k of ["handler", "rect", "latency", "frames", "longTasks"])
            stats[k] = [];
          stats.gridReplacements = 0;
          stats.callbacks = 0;
          stats.peak = stats.pending;
        };
      });
      await page.goto(base + "/#collection");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#grid .card").length === 1000 &&
          document.querySelectorAll("#tag-filter option").length > 14,
      );
      await page.locator("#grid .card").first().scrollIntoViewIfNeeded();
      await sleep(350);
      let cdp,
        trace = [],
        layers = 0,
        maxLayers = 0;
      if (engine === "chromium") {
        cdp = await page.context().newCDPSession(page);
        await cdp.send("LayerTree.enable");
        cdp.on("LayerTree.layerTreeDidChange", (e) => {
          layers = e.layers?.filter((l) => l.drawsContent).length || 0;
          maxLayers = Math.max(maxLayers, layers);
        });
        cdp.on("Tracing.dataCollected", (e) => trace.push(...e.value));
        await cdp.send("Tracing.start", {
          categories: "devtools.timeline,blink.user_timing",
          transferMode: "ReportEvents",
        });
      }
      const rect = await page.locator("#grid .card-open").first().boundingBox();
      const y = rect.y + rect.height / 2;
      for (const phase of ["traverse", "dwell-boundaries", "drag"]) {
        await page.mouse.move(2, 2);
        await sleep(250);
        await page.evaluate(() => window.resetPointerStats());
        if (phase === "drag") {
          await page.mouse.move(rect.x + rect.width / 2, y);
          await page.mouse.down();
          await page.mouse.move(rect.x + rect.width / 2 + 12, y);
          await page
            .locator(".card-action-layer")
            .waitFor({ state: "visible" });
        }
        for (let cycle = 0; cycle < 3; cycle++) {
          for (let step = 0; step < 90; step++) {
            const x = 80 + (step / 89) * 1100;
            await page.mouse.move(
              cycle % 2 ? 1280 - x : x,
              y + Math.sin(step / 10) * 18,
            );
            if (phase === "dwell-boundaries" && step % 18 === 0)
              await sleep(220);
            if (phase === "drag") await sleep(8);
          }
        }
        if (phase === "drag") {
          await page.keyboard.press("Escape");
          await page.mouse.up();
        }
        await page.mouse.move(2, 2);
        await sleep(500);
        const stats = await page.evaluate(() => window.pointerStats);
        const summary = (values) => {
          const sorted = values.slice().sort((a, b) => a - b);
          return {
            n: sorted.length,
            p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
            max: sorted.at(-1) || 0,
          };
        };
        results.push({
          engine,
          phase,
          handlerMs: summary(stats.handler),
          eventToRafMs: summary(stats.latency),
          frameMs: summary(stats.frames),
          rectReads: stats.rect.length,
          rectMs: summary(stats.rect.map((r) => r.ms)),
          gridReplacements: stats.gridReplacements,
          pendingAfterIdle: stats.pending,
          peakPending: stats.peak,
          callbacks: stats.callbacks,
          maxDrawingLayers: cdp ? maxLayers : null,
          longTasks: stats.longTaskSupported ? summary(stats.longTasks) : null,
        });
        console.log(JSON.stringify(results.at(-1)));
      }
      if (cdp) {
        const ended = new Promise((resolve) =>
          cdp.once("Tracing.tracingComplete", resolve),
        );
        await cdp.send("Tracing.end");
        await ended;
        await writeFile(
          `${output}/chromium-trace.json`,
          JSON.stringify({ traceEvents: trace }),
        );
      }
      await page.screenshot({ path: `${output}/${engine}-grid.png` });
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
} finally {
  server.kill();
}
