// Real cloud bridge for the local comparison UI. No mocked inference or writes.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
const root = resolve("public"),
  cloud = "https://exex6mzt02.execute-api.us-east-1.amazonaws.com";
const port = Number(process.env.PORT || 3200);
const config = {
  region: "us-east-1",
  clientId: "1p2inv2id7ur50opkjmuk46qnb",
  apiUrl: "",
  recognitionComparison: true,
};
const csp =
  "default-src 'self'; img-src 'self' blob: data: https://cards.scryfall.io; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com; frame-ancestors 'none'";
http
  .createServer(async (req, res) => {
    const reply = (code, body, type = "application/json") => {
      res.writeHead(code, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    };
    try {
      if (
        !["127.0.0.1", "localhost"].includes(
          (req.headers.host || "").split(":")[0],
        )
      )
        return reply(403, "{}");
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}`
      )
        return reply(403, "{}");
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === "/config.json")
        return reply(200, JSON.stringify(config));
      if (url.pathname.startsWith("/api/")) {
        const inference =
          req.method === "POST" &&
          ["/api/recognize", "/api/recognize/sagemaker"].includes(url.pathname);
        if (req.method !== "GET" && !inference)
          return reply(
            403,
            JSON.stringify({
              error: "Performance preview prohibits ownership writes",
            }),
          );
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 710000) return reply(413, "{}");
        }
        const result = await fetch(cloud + url.pathname + url.search, {
          method: req.method,
          headers: {
            authorization: req.headers.authorization || "",
            "content-type": "application/json",
          },
          ...(inference ? { body } : {}),
          signal: AbortSignal.timeout(35000),
        });
        return reply(
          result.status,
          Buffer.from(await result.arrayBuffer()),
          result.headers.get("content-type") || "application/json",
        );
      }
      if (req.method !== "GET") return reply(405, "{}");
      const path = resolve(
        root,
        url.pathname === "/"
          ? "index.html"
          : "." + decodeURIComponent(url.pathname),
      );
      if (!path.startsWith(root + sep)) return reply(404, "{}");
      const bytes = await readFile(path);
      reply(
        200,
        bytes,
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".wasm": "application/wasm",
        }[extname(path)] || "application/octet-stream",
      );
    } catch {
      reply(503, JSON.stringify({ error: "Preview resource unavailable" }));
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(
      `Comparison preview ready at http://127.0.0.1:${port}; actual cloud calls, ownership writes disabled.`,
    ),
  );
