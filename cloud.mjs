import { randomUUID, createHash } from "node:crypto";
import { jsonResponse } from "./transports/response.js";
import { createTaggedCollection } from "./application/tagged-collection.js";
import { createDynamoDocumentStore } from "./adapters/document-store.js";
import { routeCollection } from "./application/routes.js";
import { createCollectionService } from "./application/collection.js";
import { createDynamoAdapters } from "./adapters/dynamo.js";
import { createScryfallCatalog } from "./adapters/scryfall.js";
import { ApplicationError } from "./domain/inventory.js";
const adapters = createDynamoAdapters(process.env.TABLE_NAME);
const baseService = createCollectionService({
  repository: adapters.repository,
  catalog: createScryfallCatalog(adapters),
});
const service = createTaggedCollection({
  collection: baseService,
  repository: adapters.repository,
  store: createDynamoDocumentStore(process.env.TABLE_NAME),
  newId: randomUUID,
  hash: (value) => createHash("sha256").update(value).digest("hex"),
});
export async function handler(event) {
  const result = (data, statusCode = 200) =>
    jsonResponse(data, statusCode, event.headers?.["accept-encoding"]);
  try {
    if (event.requestContext?.http?.method === "OPTIONS")
      return result({}, 204);
    const owner = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!owner)
      return result({ error: "Sign in to access your collection." }, 401);
    const path = event.rawPath,
      method = event.requestContext.http.method;
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
