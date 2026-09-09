import { createReviewBatches } from "./application/review-batches.js";
import { createNameIndex } from "./adapters/name-index.js";
import { createDiscoveryService } from "./application/discovery.js";
import { randomUUID, createHash } from "node:crypto";
import { jsonResponse } from "./transports/response.js";
import { createTaggedCollection } from "./application/tagged-collection.js";
import { createDynamoDocumentStore } from "./adapters/document-store.js";
import { routeCollection } from "./application/routes.js";
import { createCollectionService } from "./application/collection.js";
import { createDynamoAdapters } from "./adapters/dynamo.js";
import { createScryfallCatalog } from "./adapters/scryfall.js";
import { ApplicationError } from "./domain/inventory.js";
import { createImportDraftService } from "./application/import-drafts.js";
import { createMoxfieldProvider } from "./adapters/moxfield.js";
const release =
  typeof __KEEPER_RELEASE__ === "undefined"
    ? { version: "local", commit: "local" }
    : __KEEPER_RELEASE__;
const adapters = createDynamoAdapters(process.env.TABLE_NAME);
const catalog = createScryfallCatalog({
  ...adapters,
  onMetric: (metric) =>
    console.info(JSON.stringify({ event: "catalog-phase", ...metric })),
});
const store = createDynamoDocumentStore(process.env.TABLE_NAME);
const baseService = createCollectionService({
  repository: adapters.repository,
  catalog,
});
const tagged = createTaggedCollection({
  collection: baseService,
  repository: adapters.repository,
  store,
  newId: randomUUID,
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
const service = {
  ...tagged,
  ...createReviewBatches({ repository: adapters.repository, store }),
  ...createDiscoveryService({
    names: createNameIndex({
      origin: "https://d3r1grp0vvv9f.cloudfront.net",
      seedDirectory: "catalog",
      onMetric: (metric) =>
        console.info(JSON.stringify({ event: "catalog-phase", ...metric })),
    }),
    catalog,
  }),
  ...createImportDraftService({
    store,
    catalog,
    repository: adapters.repository,
    collection: tagged,
    newId: randomUUID,
    provider: createMoxfieldProvider({
      rateLimit: createDynamoAdapters(process.env.TABLE_NAME, "moxfield")
        .rateLimit,
      ...(process.env.MOXFIELD_USER_AGENT
        ? { userAgent: process.env.MOXFIELD_USER_AGENT }
        : {}),
    }),
  }),
};
export async function handler(event) {
  const result = (data, statusCode = 200) => {
    const response = jsonResponse(
      data,
      statusCode,
      event.headers?.["accept-encoding"],
    );
    response.headers["x-keeper-version"] = release.version;
    response.headers["x-keeper-commit"] = release.commit;
    return response;
  };
  try {
    if (event.requestContext?.http?.method === "OPTIONS")
      return result({}, 204);
    const owner = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!owner)
      return result({ error: "Sign in to access your collection." }, 401);
    const path = event.rawPath,
      method = event.requestContext.http.method;
    if (path === "/api/session" && method === "GET") return result({ owner });
    let input = {};
    if (event.body) {
      if (event.body.length > 150000)
        throw new ApplicationError("Request too large.", 413);
      try {
        input = JSON.parse(event.body);
      } catch {
        throw new ApplicationError("Invalid request.");
      }
    }
    const data = await routeCollection(
      service,
      owner,
      method,
      path,
      input,
      event.queryStringParameters || {},
    );
    if (data !== undefined)
      return result(
        data,
        path === "/api/collection" && method === "POST" ? 201 : 200,
      );
    return result({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error.name, error.message);
    return result(
      {
        error: error.status
          ? error.message
          : "Something went wrong. Please try again.",
      },
      error.status || 500,
    );
  }
}
