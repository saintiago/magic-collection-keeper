import { expect } from "@playwright/test";
import { createHash } from "node:crypto";

export async function liveApi(page, path, options = {}) {
  return page.evaluate(
    async ({ path, options }) => {
      const module = document.querySelector('script[type="module"]').src;
      const { api } = await import(new URL("api.js", module).href);
      return api(path, options);
    },
    { path, options },
  );
}

// Public catalog artwork in a generated frame; never physical-camera evidence.
export async function exerciseBackendScanner({ page }, test) {
  test.setTimeout(180000);
  await page.goto("/#collection");
  const config = await page.request.get("/config.json").then((r) => r.json());
  test.skip(
    config.backendRecognition !== true,
    "Server recognition is not enabled for this deployment",
  );
  expect(process.env.KEEPER_TEST_USER).toBe("keeper-e2e");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TEST_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const before = await liveApi(page, "/api/collection");
  expect(before).toEqual([]);
  const found = await liveApi(
    page,
    "/api/search?q=" + encodeURIComponent('!"Adaptive Training Post" set:tdc'),
  );
  const card = found.cards.find(
    (c) => c.id === "4796e5e4-515c-4d89-92da-b2d5b5b39557",
  );
  expect(card).toBeTruthy();
  const response = await fetch(card.image_uris.normal, {
    headers: {
      "User-Agent":
        "MagicCollectionKeeper/0.1 (+https://github.com/saintiago/magic-collection-keeper)",
      Accept: "image/jpeg",
    },
  });
  expect(response.ok).toBeTruthy();
  const image = Buffer.from(await response.arrayBuffer()).toString("base64");
  const frames = await page.evaluate(async (image) => {
    const photo = new Image();
    photo.src = "data:image/jpeg;base64," + image;
    await photo.decode();
    const c = document.createElement("canvas");
    c.width = 700;
    c.height = 980;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 700, 980);
    const blank = c.toDataURL("image/jpeg", 0.85).split(",")[1];
    ctx.fillStyle = "rgb(50,65,57)";
    ctx.fillRect(0, 0, 700, 980);
    const scale = Math.min(480 / photo.width, 670 / photo.height);
    const w = photo.width * scale,
      h = photo.height * scale;
    ctx.drawImage(photo, (700 - w) / 2, (980 - h) / 2, w, h);
    return { blank, card: c.toDataURL("image/jpeg", 0.88).split(",")[1] };
  }, image);
  const upload = (key) =>
    page.locator("#photo").setInputFiles({
      name: "public-synthetic-" + key + ".jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(frames[key], "base64"),
    });
  try {
    await page.locator("#scan").click();
    await expect(
      page.getByText("Recognition runs on this device", { exact: false }),
    ).toBeVisible();
    expect(process.env.RECOGNITION_SOURCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    await expect(page.locator("#scan-preparation")).toHaveText(
      "Scanner ready.",
      { timeout: 90000 },
    );
    const downloading = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Recognition source (AGPL-3.0)" })
      .click();
    const download = await downloading;
    const stream = await download.createReadStream();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    expect(bytes).toBeGreaterThan(100000);
    expect(hash.digest("hex")).toBe(process.env.RECOGNITION_SOURCE_SHA256);
    await upload("blank");
    await expect(page.locator("#scan-status")).toContainText(
      "No copy counted",
      { timeout: 60000 },
    );
    await expect(page.locator("#scan-count")).toHaveText(
      "0 matched · 0 copies",
    );
    await expect(page.locator("#scan-possible")).toBeHidden();
    for (let i = 0; i < 2; i++) {
      await upload("card");
      await expect(page.locator("#scan-possible")).toBeVisible({
        timeout: 60000,
      });
      await expect(page.locator("#scan-count")).toHaveText(
        `${i} matched · ${i} copies`,
      );
      const panel = page.locator("#scan-possible");
      if (!(await panel.evaluate((el) => el.open)))
        await panel.locator("summary").click();
      await panel
        .getByRole("button", {
          name: "Adaptive Training Post · tdc #58 · en",
          exact: true,
        })
        .click();
      await expect(page.locator("#scan-count")).toHaveText(
        `${i + 1} matched · ${i + 1} copies`,
      );
    }
    await expect
      .poll(() =>
        page
          .locator("#scan-wheel")
          .evaluate((el) =>
            Math.abs(
              document.querySelector(".scan-footer").getBoundingClientRect()
                .top - el.lastElementChild.getBoundingClientRect().bottom,
            ),
          ),
      )
      .toBeLessThan(2);
    await page.screenshot({
      path: test.info().outputPath("deployed-backend-candidates.png"),
    });
    await page.locator(".scan-plus").click();
    await page.locator("#scan-review").click();
    await expect(page.locator(".review-row")).toHaveCount(2);
    await expect(page.locator("#save-batch")).toBeDisabled();
    expect(await liveApi(page, "/api/collection")).toEqual([]);
    await page.locator("#ownership").check();
    await page.locator("#save-batch").click();
    await expect(page.locator("#batch-status")).toContainText(
      "2 reviewed entries added",
      { timeout: 30000 },
    );
    await page.locator("#batch-close").click();
    await page.reload();
    await expect(page.locator("#total")).toHaveText("3");
    const saved = await liveApi(page, "/api/collection");
    expect(saved).toHaveLength(1);
    expect(saved[0].quantity).toBe(3);
  } finally {
    const entries = await liveApi(page, "/api/collection");
    for (const entry of entries)
      await liveApi(page, "/api/collection/" + entry.id, { method: "DELETE" });
    expect(await liveApi(page, "/api/collection")).toEqual(before);
    await page.reload();
    await page.locator("#sign-out").click();
  }
}
