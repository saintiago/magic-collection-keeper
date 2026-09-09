import { test, expect } from "./fixtures.js";
import { packageWebsite } from "../../scripts/release.mjs";
import { readFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { resolve, join, sep, extname } from "node:path";
import { createHash } from "node:crypto";
import { verifySourceDownload } from "../helpers/source-bundle.js";

let site;
const backend = Buffer.from("private source fixture");
const frontend = Buffer.from("exact frontend source fixture");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const release = {
  channel: "deployment",
  schema: 1,
  id: "r901-a1",
  version: "0.1.0+deploy.901.1",
  commit: "a".repeat(40),
  mode: "frontend",
  assets: { id: "r900-a1" },
  api: { commit: "b".repeat(40), version: "0.1.0+deploy.900.1" },
  recognition: { version: "14", sourceSha256: hash(backend) },
  sourceOverlay: {
    file: "frontend-source.zip",
    bytes: frontend.length,
    sha256: hash(frontend),
  },
};
test.beforeAll(async () => {
  await mkdir("build", { recursive: true });
  site = await mkdtemp(resolve("build/frontend-browser-"));
  await packageWebsite({
    source: "public",
    destination: site,
    release: { ...release, id: "r900-a1" },
  });
  await packageWebsite({
    source: "public",
    destination: site,
    release,
    reuseAssets: true,
  });
});
test.afterAll(async () => {
  if (site) {
    expect(resolve(site).startsWith(resolve("build") + sep)).toBe(true);
    await rm(site, { recursive: true, force: true });
  }
});

async function setup(page) {
  const errors = [],
    vendorRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/vendor/"))
      vendorRequests.push(new URL(r.url()).pathname);
  });
  await page.route("**/releases/**", async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name.endsWith("config.json"))
      return route.fulfill({ json: { local: true } });
    const path = resolve(site, name);
    expect(path.startsWith(site + sep)).toBe(true);
    const types = {
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".css": "text/css",
      ".woff2": "font/woff2",
    };
    try {
      await route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] || "application/octet-stream",
      });
    } catch {
      await route.fulfill({ status: 404, body: "Missing packaged asset" });
    }
  });
  await page.route("http://127.0.0.1:3100/", async (route) =>
    route.fulfill({
      body: await readFile(join(site, "index.html")),
      contentType: "text/html",
    }),
  );
  await page.goto("/");
  await expect(page.locator("#app-version")).toHaveText(
    "App " + release.version,
  );
  return { errors, vendorRequests };
}

test("DEPLOY-01/04 packaged frontend starts real workers using only the previous immutable vendor release", async ({
  page,
}) => {
  test.setTimeout(120000);
  const { errors, vendorRequests } = await setup(page);
  await expect(stat(join(site, "releases/r901-a1/vendor"))).rejects.toThrow();
  const result = await page.evaluate(async () => {
    const { createCardPresence } =
      await import("/releases/r901-a1/card-presence.js");
    const { createBrowserRecognition } =
      await import("/releases/r901-a1/browser-recognition.js");
    const presence = createCardPresence(),
      visual = createBrowserRecognition({
        request: async () => {
          throw Error("No catalog lookup expected during preparation");
        },
      });
    try {
      await presence.prepare();
      const canvas = document.createElement("canvas");
      canvas.width = 384;
      canvas.height = 384;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 384, 384);
      const geometry = await presence.inspect(canvas);
      await visual.prepare();
      return geometry.state;
    } finally {
      presence.dispose();
      visual.dispose();
    }
  });
  expect(result).toBe("none");
  expect(vendorRequests.length).toBeGreaterThan(5);
  expect(
    vendorRequests.every((path) =>
      path.startsWith("/releases/r900-a1/vendor/"),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("DEPLOY-04 source UI retries corrupt downloads and discards completion after close", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/recognition/source", (r) =>
    r.fulfill({ body: backend, contentType: "application/zip" }),
  );
  let corrupt = true,
    finish;
  await page.route("**/frontend-source.zip", async (r) => {
    if (finish) await finish;
    await r
      .fulfill({
        body: corrupt ? Buffer.from("bad") : frontend,
        contentType: "application/zip",
      })
      .catch(() => {});
  });
  await page.locator("#app-version").click();
  const sourceButton = page.getByRole("button", {
    name: "Download Recognition source (AGPL-3.0)",
  });
  await sourceButton.click();
  await expect(page.locator(".release-dialog")).toContainText(
    "integrity verification",
  );
  await expect(sourceButton).toBeEnabled();
  corrupt = false;
  const downloading = page.waitForEvent("download");
  await sourceButton.click();
  const download = await downloading,
    chunks = [];
  for await (const part of await download.createReadStream()) chunks.push(part);
  verifySourceDownload(
    Buffer.concat(chunks),
    release,
    release.recognition.sourceSha256,
  );
  let complete;
  finish = new Promise((resolve) => {
    complete = resolve;
  });
  let lateDownloads = 0;
  page.on("download", () => lateDownloads++);
  await sourceButton.click();
  await page.getByRole("button", { name: "Close about" }).click();
  complete();
  await expect(page.locator(".release-dialog")).toHaveCount(0);
  await page.waitForTimeout(150);
  expect(lateDownloads).toBe(0);
});
