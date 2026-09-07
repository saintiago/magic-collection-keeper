import { gzipSync } from "node:zlib";
export function jsonResponse(data, statusCode = 200, acceptEncoding = "") {
  const body = JSON.stringify(data);
  const gzipAccepted = acceptEncoding.split(",").some((item) => {
    const [coding, ...parameters] = item.trim().toLowerCase().split(";");
    return (
      coding === "gzip" &&
      !parameters.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p))
    );
  });
  const compress = gzipAccepted && Buffer.byteLength(body) > 1024;
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "Accept-Encoding",
      ...(compress ? { "content-encoding": "gzip" } : {}),
    },
    isBase64Encoded: compress,
    body: compress ? gzipSync(body).toString("base64") : body,
  };
}
