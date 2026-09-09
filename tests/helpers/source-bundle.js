import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Independent reader of the small uncompressed POSIX archive used by the source
// offer. Never extracts paths or executes bundled code.
export function verifySourceDownload(bytes, release, expectedSource) {
  if (!release.sourceOverlay) {
    assert.equal(hash(bytes), expectedSource);
    return;
  }
  assert.ok(bytes.length < 8_100_000);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .split("\0")[0]
        .trim();
    assert.equal(text(257, 6), "ustar");
    const checksum = Number.parseInt(text(148, 8), 8);
    const sum = header.reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert.equal(sum, checksum);
    const name = text(0, 100),
      length = Number.parseInt(text(124, 12), 8);
    assert.ok(
      Number.isSafeInteger(length) && length >= 0 && length <= 4_000_000,
    );
    assert.ok(!files.has(name));
    const data = bytes.subarray(offset + 512, offset + 512 + length);
    assert.equal(data.length, length);
    files.set(name, data);
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  assert.deepEqual(
    [...files.keys()],
    [
      "README.txt",
      "deployment.json",
      "backend-source.zip",
      "frontend-source.zip",
    ],
  );
  assert.equal(hash(files.get("backend-source.zip")), expectedSource);
  assert.equal(
    hash(files.get("backend-source.zip")),
    release.recognition.sourceSha256,
  );
  assert.equal(
    hash(files.get("frontend-source.zip")),
    release.sourceOverlay.sha256,
  );
  assert.equal(
    files.get("frontend-source.zip").length,
    release.sourceOverlay.bytes,
  );
  const manifest = JSON.parse(files.get("deployment.json"));
  assert.equal(manifest.frontend.commit, release.commit);
  assert.equal(manifest.frontend.version, release.version);
  assert.deepEqual(manifest.api, release.api);
  assert.deepEqual(manifest.recognition, release.recognition);
}
