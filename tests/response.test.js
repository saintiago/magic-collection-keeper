import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { jsonResponse } from "../transports/response.js";
test("large collection responses preserve Unicode and fit the Lambda envelope with negotiated gzip", () => {
  const data = Array.from({ length: 4000 }, (_, id) => ({
    id,
    name: "Éowyn × Commander",
    text: "Card rules and source metadata ".repeat(70),
  }));
  const result = jsonResponse(data, 200, "gzip, deflate, br");
  assert.equal(result.headers["content-encoding"], "gzip");
  assert.equal(result.isBase64Encoded, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 6000000);
  assert.deepEqual(
    JSON.parse(gunzipSync(Buffer.from(result.body, "base64"))),
    data,
  );
  for (const encoding of ["", "br", "gzip;q=0"])
    assert.equal(
      jsonResponse({ text: "a".repeat(2000) }, 200, encoding).isBase64Encoded,
      false,
    );
});
