// Real browser worker initialization under optional emulated network throughput.
// No card capture, login, cloud invocation or inventory operation is performed.
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const report = {
  at: new Date().toISOString(),
  kind: "worker preparation only",
  physicalDeviceVerified: false,
  emulatedAssetBytesPerSecond: Number(
    process.env.PERF_ASSET_BYTES_PER_SECOND || 0,
  ),
  phases: [],
  resources: [],
};
page.on("requestfinished", async (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/vendor/"))
    report.resources.push({ path: url.pathname, ...(await request.sizes()) });
});
try {
  await page.goto(process.env.PERF_URL || "http://127.0.0.1:3200");
  for (const phase of ["fresh-browser-context", "new-worker-retained-cache"]) {
    if (report.phases.length) await page.reload();
    const metrics = await page.evaluate(async () => {
      const { createBrowserRecognition } =
        await import("/browser-recognition.js");
      const port = createBrowserRecognition({
        request: () => {
          throw Error("No catalog call during preparation");
        },
      });
      const started = performance.now();
      const metrics = await port.prepare();
      port.dispose();
      return { ...metrics, totalMs: performance.now() - started };
    });
    report.phases.push({ phase, ...metrics });
    console.log(JSON.stringify(report.phases.at(-1)));
  }
} catch (error) {
  report.error = { name: error.name, message: error.message };
} finally {
  await browser.close();
  await writeFile(process.env.PERF_OUTPUT, JSON.stringify(report, null, 2));
}
