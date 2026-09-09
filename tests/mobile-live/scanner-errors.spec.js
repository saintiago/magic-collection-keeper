import { publicCardFrame } from "../helpers/public-frame.js";
import { test, expect } from "@playwright/test";

test("LIVE-13 unknown recognition does not count copies; optional candidates and wheel review stay separate", async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.goto("/");
  await page
    .getByLabel("Username", { exact: true })
    .fill(process.env.KEEPER_TAGS_USER);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env.KEEPER_TAGS_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-dialog")).toHaveCount(0);
  const writes = [];
  page.on("request", (r) => {
    if (
      r.url().includes("/api/collection") &&
      !["GET", "HEAD", "OPTIONS"].includes(r.method())
    )
      writes.push(r.method() + " " + new URL(r.url()).pathname);
  });
  await page.locator("#scan").click();
  await expect(page.locator("#scan-preparation")).toHaveText("Scanner ready.", {
    timeout: 90000,
  });
  const images = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 980;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 700, 980);
    const blank = canvas.toDataURL().split(",")[1];
    ctx.fillStyle = "black";
    ctx.font = "bold 46px Arial";
    ctx.fillText("Lightning Bolt", 35, 80);
    const name = canvas.toDataURL().split(",")[1];
    ctx.font = "30px Arial";
    ctx.fillText("Instant", 35, 620);
    ctx.fillText("149", 35, 870);
    ctx.fillText("M11 EN", 35, 920);
    return { blank, name, exact: canvas.toDataURL().split(",")[1] };
  });
  const upload = async (key) =>
    page.locator("#photo").setInputFiles({
      name: key + ".png",
      mimeType: key === "exact" ? "image/jpeg" : "image/png",
      buffer: Buffer.from(images[key], "base64"),
    });
  await upload("blank");
  await expect(page.locator("#scan-status")).toContainText("No copy counted", {
    timeout: 60000,
  });
  await expect(page.locator("#scan-count")).toHaveText("0 queued · 0 copies");
  await expect(page.locator(".scan-option")).toHaveCount(0);
  await expect(page.locator("#scan-review")).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("scanner-failed-no-copy.png"),
  });
  images.exact = (await publicCardFrame(page)).split(",")[1];
  for (let i = 1; i <= 5; i++) {
    await upload("exact");
    await expect(page.locator(".scan-option")).toHaveCount(i);
  }
  await upload("exact");
  await expect(page.locator("#scan-count")).toHaveText("6 queued · 6 copies", {
    timeout: 60000,
  });
  const wheel = page.locator("#scan-wheel");
  await expect
    .poll(() =>
      wheel.evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().bottom -
            el.lastElementChild.getBoundingClientRect().bottom,
        ),
      ),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("scanner-live-newest.png"),
  });
  await expect
    .poll(() =>
      wheel.evaluate((el) =>
        Math.abs(
          document.querySelector(".scan-footer").getBoundingClientRect().top -
            el.querySelector('[aria-selected="true"]').getBoundingClientRect()
              .bottom,
        ),
      ),
    )
    .toBeLessThan(2);
  await wheel.press("ArrowUp");
  await expect
    .poll(() =>
      wheel.evaluate((el) => {
        const row = el.querySelector('[aria-selected="true"]');
        return Math.abs(
          row.offsetTop +
            row.offsetHeight / 2 -
            el.scrollTop -
            el.clientHeight / 2,
        );
      }),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("scanner-live-history.png"),
  });
  await page.locator("#scan-review").click();
  await expect(page.locator(".draft-row")).toHaveCount(6);
  await expect(page.locator("#draft-add")).toBeEnabled();
  await page.locator("#draft-clear").click();
  await expect(page.locator(".draft-row")).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.locator("#sign-out").click();
  console.log(
    JSON.stringify({
      liveScanner: true,
      realModels: true,
      syntheticPhotos: true,
      physicalCameraVerified: false,
      failedCopies: 0,
      suggestedRows: 6,
      explicitOwnershipRequired: true,
      writes,
    }),
  );
});
