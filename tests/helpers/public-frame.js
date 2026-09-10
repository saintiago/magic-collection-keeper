import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Frozen public artwork; no user images or simulated model output.
export async function publicCardFrame(page, fixtureIndex = 0) {
  const source = JSON.parse(
    await readFile(new URL("../performance/sources.json", import.meta.url)),
  )[fixtureIndex];
  const response = await fetch(source.url, {
    headers: {
      "User-Agent":
        "MagicCollectionKeeper/0.1 (+https://github.com/saintiago/magic-collection-keeper)",
      Accept: "image/jpeg",
    },
  });
  if (!response.ok)
    throw Error(`Public fixture unavailable (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    throw Error("Public fixture changed");
  return page.evaluate(async (encoded) => {
    const photo = new Image();
    photo.src = "data:image/jpeg;base64," + encoded;
    await photo.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 700;
    canvas.height = 980;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(50,65,57)";
    ctx.fillRect(0, 0, 700, 980);
    const scale = Math.min(480 / photo.width, 670 / photo.height);
    const w = photo.width * scale,
      h = photo.height * scale;
    ctx.drawImage(photo, (700 - w) / 2, (980 - h) / 2, w, h);
    return canvas.toDataURL("image/jpeg", 0.88);
  }, bytes.toString("base64"));
}
