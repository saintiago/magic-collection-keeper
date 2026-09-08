// Actual scan-screen E2E benchmark. Public synthetic frames, reserved login only.
import { chromium, webkit, devices } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const folder = resolve(
  process.env.PERF_FIXTURES || "data/recognition-benchmark",
);
const fixtures = JSON.parse(await readFile(resolve(folder, "fixtures.json")));
const credentials = JSON.parse(await readFile(process.env.PERF_CREDENTIALS));
if (credentials.KEEPER_TEST_USER !== "keeper-e2e")
  throw Error("Reserved keeper-e2e profile required");
const modes = (
  process.env.PERF_MODES || "ocr,lambda,sagemaker,browser-onnx"
).split(",");
const browserName = process.env.PERF_BROWSER || "chromium";
const mobile = process.env.PERF_MOBILE === "true";
const rounds = Number(process.env.PERF_ROUNDS || 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 4)
  throw Error("Bounded rounds required");
const report = {
  schema: 1,
  at: new Date().toISOString(),
  browser: browserName,
  mobileViewportEmulation: mobile,
  physicalDeviceVerified: false,
  transport: "actual cloud through loopback bridge; upload-photo UI",
  targets: {
    cachedReadyMs: 3000,
    medianCandidateMs: 1500,
    p95CandidateMs: 3000,
  },
  percentileMethod:
    "nearest-rank; failures retained in all-attempt latency; repeated fixtures are not independent accuracy samples",
  runs: [],
};
const output = resolve(
  folder,
  `results-${browserName}-${modes.join("-")}-${Date.now()}.json`,
);
const browser = await { chromium, webkit }[browserName].launch({
  headless: true,
});
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const save = () => writeFile(output, JSON.stringify(report, null, 2));
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};
try {
  for (const mode of modes) {
    const context = await browser.newContext(
      mobile
        ? devices["iPhone 13"]
        : { viewport: { width: 1100, height: 850 } },
    );
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.scanMeasurements = [];
      window.addEventListener("keeper-scan-measurement", (e) =>
        window.scanMeasurements.push(e.detail),
      );
    });
    const network = {
      requests: 0,
      requestBytes: 0,
      responseBytes: 0,
      failed: 0,
    };
    const pending = [];
    page.on("requestfinished", (request) => {
      pending.push(
        request
          .sizes()
          .then((size) => {
            network.requests++;
            network.requestBytes +=
              size.requestBodySize + size.requestHeadersSize;
            network.responseBytes +=
              size.responseBodySize + size.responseHeadersSize;
          })
          .catch(() => {}),
      );
    });
    page.on("requestfailed", () => network.failed++);
    const run = {
      mode,
      phase: "fresh-browser-context",
      networkDefinition:
        "Playwright encoded request/response body and header sizes; excludes TLS; browser cache may report zero",
      attempts: [],
      startup: [],
    };
    report.runs.push(run);
    try {
      await page.goto(process.env.PERF_URL || "http://127.0.0.1:3200");
      await page
        .getByLabel("Username", { exact: true })
        .fill(credentials.KEEPER_TEST_USER);
      await page
        .getByLabel("Password", { exact: true })
        .fill(credentials.KEEPER_TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .locator(".auth-dialog")
        .waitFor({ state: "detached", timeout: 20000 });
      const before = await page.evaluate(async () =>
        (await import("/api.js")).api("/api/collection"),
      );
      if (!Array.isArray(before) || before.length !== 0)
        throw Error(
          "Performance profile must start empty; no automatic cleanup permitted",
        );
      run.environment = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        crossOriginIsolated,
        webgpuAdvertised: Boolean(navigator.gpu),
        memory: performance.memory
          ? {
              usedJSHeapBytes: performance.memory.usedJSHeapSize,
              scope: "main JS heap only; excludes worker/WASM/GPU",
            }
          : null,
      }));
      await page
        .getByRole("button", { name: "▣ Scan cards", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Comparison mode" })
        .selectOption(mode);
      for (let round = 0; round < rounds; round++) {
        for (const fixture of fixtures.cases) {
          const path = resolve(folder, "frames", fixture.file);
          if (
            createHash("sha256")
              .update(await readFile(path))
              .digest("hex") !== fixture.sha256
          )
            throw Error("Fixture integrity mismatch");
          const count = await page.evaluate(
            () => window.scanMeasurements.length,
          );
          await Promise.all(pending);
          const netBefore = { ...network };
          const start = performance.now();
          await page.locator("#photo").setInputFiles(path);
          let measurement;
          try {
            await page.waitForFunction(
              (count) => window.scanMeasurements.length > count,
              count,
              { timeout: 40000 },
            );
            measurement = await page.evaluate(() =>
              window.scanMeasurements.at(-1),
            );
          } catch {
            measurement = {
              outcome: "timeout",
              captureToCandidateMs: performance.now() - start,
              selected: null,
              candidates: [],
            };
            // Stop the failed attempt before advancing; never label its later result warm.
            await page
              .getByRole("combobox", { name: "Comparison mode" })
              .selectOption(mode === "ocr" ? "lambda" : "ocr");
            await page
              .getByRole("combobox", { name: "Comparison mode" })
              .selectOption(mode);
          }
          await Promise.all(pending);
          const candidates = measurement.candidates || [];
          const item = {
            fixture: fixture.key,
            kind: fixture.kind,
            round,
            ...measurement,
            uploadToVisibleMs: performance.now() - start,
            oracleTop1: fixture.oracle
              ? candidates[0]?.oracle_id === fixture.oracle
              : null,
            oracleInCandidates: fixture.oracle
              ? candidates.some((c) => c.oracle_id === fixture.oracle)
              : null,
            printingInCandidates: fixture.printing
              ? candidates.some((c) => c.id === fixture.printing)
              : null,
            safeUnresolved:
              fixture.kind.startsWith("ambiguous") ||
              fixture.kind === "negative"
                ? measurement.selected === null
                : null,
            negativeRejected:
              fixture.kind === "negative"
                ? measurement.outcome === "unknown"
                : null,
            network: Object.fromEntries(
              Object.keys(network).map((key) => [
                key,
                network[key] - netBefore[key],
              ]),
            ),
          };
          run.attempts.push(item);
          await save();
          console.log(
            JSON.stringify({
              mode,
              fixture: fixture.key,
              round,
              outcome: item.outcome,
              ms: Math.round(item.uploadToVisibleMs),
              oracle: item.oracleTop1,
            }),
          );
        }
      }
      const after = await page.evaluate(async () =>
        (await import("/api.js")).api("/api/collection"),
      );
      run.inventoryUnchanged = hash(before) === hash(after);
      if (!run.inventoryUnchanged)
        throw Error("Inventory changed during read-only comparison");
      // New page/worker with retained model cache; independently reported startup.
      if (mode === "browser-onnx") {
        await page.reload();
        await page
          .getByRole("button", { name: "▣ Scan cards", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Comparison mode" })
          .selectOption(mode);
        await page
          .locator("#photo")
          .setInputFiles(resolve(folder, "frames", fixtures.cases[0].file));
        await page.waitForFunction(
          () => window.scanMeasurements.length > 0,
          null,
          { timeout: 40000 },
        );
        run.startup.push({
          phase: "new-worker-retained-asset-cache",
          ...(await page.evaluate(() => window.scanMeasurements.at(-1))),
        });
      }
      await page.getByRole("button", { name: "‹ Back", exact: true }).click();
      const reviewClose = page.locator("#batch-close");
      if (await reviewClose.isVisible()) {
        page.once("dialog", (d) => d.accept());
        await reviewClose.click();
      }
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    } catch (error) {
      run.failure = error.message;
    } finally {
      const latency = run.attempts.map((a) => a.uploadToVisibleMs),
        positives = run.attempts.filter((a) => a.oracleTop1 !== null),
        negatives = run.attempts.filter((a) => a.negativeRejected !== null);
      run.summary = {
        attempts: run.attempts.length,
        p50Ms: percentile(latency, 0.5),
        p95Ms: percentile(latency, 0.95),
        correctCandidateP50Ms: percentile(
          positives.filter((a) => a.oracleTop1).map((a) => a.uploadToVisibleMs),
          0.5,
        ),
        correctCandidateP95Ms: percentile(
          positives.filter((a) => a.oracleTop1).map((a) => a.uploadToVisibleMs),
          0.95,
        ),
        unknown: run.attempts.filter((a) => a.outcome === "unknown").length,
        failures: run.attempts.filter((a) =>
          ["error", "timeout"].includes(a.outcome),
        ).length,
        oracleTop1Correct: positives.filter((a) => a.oracleTop1).length,
        oracleTrials: positives.length,
        negativesRejected: negatives.filter((a) => a.negativeRejected).length,
        negativeTrials: negatives.length,
        unsafeUnresolved: run.attempts.filter((a) => a.safeUnresolved === false)
          .length,
      };
      await save();
      await context.close();
    }
  }
} finally {
  await browser.close();
  await save();
  console.log("Report: " + output);
}
if (report.runs.some((run) => run.failure || run.summary.unsafeUnresolved))
  process.exitCode = 1;
