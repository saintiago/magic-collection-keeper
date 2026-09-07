import { randomUUID, createHash } from "node:crypto";
import { createTaggedCollection } from "./application/tagged-collection.js";
import { createSqliteDocumentStore } from "./adapters/document-store.js";
import { routeCollection } from "./application/routes.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { openDatabase } from "./db.js";
import { createSqliteAdapters } from "./adapters/sqlite.js";
import { createScryfallCatalog } from "./adapters/scryfall.js";
import { createCollectionService } from "./application/collection.js";
import { ApplicationError } from "./domain/inventory.js";
const root = fileURLToPath(new URL(".", import.meta.url));
const db = openDatabase(
  process.env.DB_PATH || resolve(root, "data/collection.sqlite"),
);
const adapters = createSqliteAdapters(db);
const baseService = createCollectionService({
  repository: adapters.repository,
  catalog: createScryfallCatalog(adapters),
});
const service = createTaggedCollection({
  collection: baseService,
  repository: adapters.repository,
  store: createSqliteDocumentStore(db),
  newId: randomUUID,
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
const port = Number(process.env.PORT || 3000);
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 150000)
      throw new ApplicationError("Request too large", 413);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApplicationError("Invalid JSON");
  }
}
const server = http.createServer(async (req, res) => {
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    if (
      !["localhost", "127.0.0.1"].includes(
        (req.headers.host || "").split(":")[0],
      )
    )
      return json({ error: "Local access only" }, 403);
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return json({ error: "Cross-origin request rejected" }, 403);
    const url = new URL(req.url, `http://localhost:${port}`),
      owner = "local";
    if (url.pathname.startsWith("/api/")) {
      const input = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await body(req)
        : {};
      const data = await routeCollection(
        service,
        owner,
        req.method,
        url.pathname,
        input,
        Object.fromEntries(url.searchParams),
      );
      if (data !== undefined)
        return json(
          data,
          url.pathname === "/api/collection" && req.method === "POST"
            ? 201
            : 200,
        );
    }
    if (url.pathname.startsWith("/api/"))
      return json({ error: "Not found" }, 404);
    if (url.pathname === "/config.json") return json({ local: true });
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      publicRoot = resolve(root, "public"),
      absolute = resolve(publicRoot, file);
    if (req.method !== "GET" || !absolute.startsWith(publicRoot + sep))
      return json({ error: "Not found" }, 404);
    let content;
    try {
      content = await readFile(absolute);
    } catch {
      return json({ error: "Not found" }, 404);
    }
    res.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".gz": "application/octet-stream",
        }[extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' blob: data: https://cards.scryfall.io; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com; frame-ancestors 'none'",
    });
    res.end(content);
  } catch (error) {
    console.error(error.message);
    json(
      {
        error: error.status
          ? error.message
          : "Something went wrong. Please try again.",
      },
      error.status || 500,
    );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Collection Keeper is ready at http://localhost:${port}`),
);
