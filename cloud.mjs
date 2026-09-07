import { createCollectionService } from "./application/collection.js";
import { createDynamoAdapters } from "./adapters/dynamo.js";
import { createScryfallCatalog } from "./adapters/scryfall.js";
import { ApplicationError } from "./domain/inventory.js";
const adapters = createDynamoAdapters(process.env.TABLE_NAME);
const service = createCollectionService({
  repository: adapters.repository,
  catalog: createScryfallCatalog(adapters),
});
export async function handler(event) {
  const result = (data, statusCode = 200) => ({
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(data),
  });
  try {
    if (event.requestContext?.http?.method === "OPTIONS")
      return result({}, 204);
    const owner = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!owner)
      return result({ error: "Sign in to access your collection." }, 401);
    const path = event.rawPath,
      method = event.requestContext.http.method;
    if (path === "/api/collection" && method === "GET")
      return result(await service.list(owner));
    if (path === "/api/search" && method === "GET")
      return result(
        await service.search(
          (event.queryStringParameters?.q || "").trim(),
          Number(event.queryStringParameters?.page || 1),
        ),
      );
    let input = {};
    if (event.body) {
      if (event.body.length > 16000)
        throw new ApplicationError("Request too large.", 413);
      try {
        input = JSON.parse(event.body);
      } catch {
        throw new ApplicationError("Invalid request.");
      }
    }
    if (path === "/api/collection" && method === "POST")
      return result(await service.add(owner, input), 201);
    const match = path.match(/^\/api\/collection\/([a-f0-9]{64})$/);
    if (match && method === "PATCH")
      return result(await service.setQuantity(owner, match[1], input.quantity));
    if (match && method === "DELETE")
      return result(await service.remove(owner, match[1]));
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
