import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const root = new URL("./", import.meta.url),
  publicRoot = new URL("../../public/", root);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const name = path === "/" ? "index.html" : path.slice(1);
  const local = [
    "index.html",
    "prototype.js",
    "wheel-webgl.js",
    "prototype.css",
    "cards.json",
  ].includes(name);
  if (
    request.method !== "GET" ||
    (!local && !/^[a-z0-9-]+\.(js|css)$/.test(name))
  ) {
    response.writeHead(404);
    response.end("Local prototype: no API or account access");
    return;
  }
  try {
    const body = await readFile(new URL(name, local ? root : publicRoot));
    response.writeHead(200, {
      "Content-Type": name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : name.endsWith(".json")
            ? "application/json"
            : "text/html",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' blob: data: https://cards.scryfall.io; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});
server.listen(3120, "127.0.0.1", () =>
  console.log(
    "Local card prototype: http://127.0.0.1:3120/ · sample data only",
  ),
);
