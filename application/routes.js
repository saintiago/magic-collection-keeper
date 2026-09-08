// Shared API dispatch keeps local and cloud transports behaviorally aligned.
export async function routeCollection(
  service,
  owner,
  method,
  path,
  input,
  query = {},
) {
  if (path === "/api/discover" && method === "GET")
    return service.discover(
      (query.q || "").trim(),
      Number(query.page || 1),
      query.oracle || "",
      query.printing || "",
    );
  if (path === "/api/suggest" && method === "GET")
    return service.suggest((query.q || "").trim());
  if (path === "/api/import-draft" && method === "GET")
    return service.getDraft(owner);
  if (path === "/api/import-draft" && method === "PATCH")
    return service.saveDraft(owner, input);
  if (path === "/api/import-draft/fetch" && method === "POST")
    return service.fetchDraft(owner, input);
  if (path === "/api/import-draft/add" && method === "POST")
    return service.addDraft(owner, input);
  if (path === "/api/import-draft/clear" && method === "POST")
    return service.clearDraft(owner, input);
  if (path === "/api/collection" && method === "GET")
    return service.list(owner);
  if (path === "/api/collection" && method === "POST")
    return service.add(owner, input);
  if (path === "/api/search" && method === "GET")
    return service.search((query.q || "").trim(), Number(query.page || 1));
  if (path === "/api/tags" && method === "GET") return service.tags(owner);
  if (path === "/api/tags" && method === "POST")
    return service.createTag(owner, input);
  if (path === "/api/deck-imports" && method === "GET")
    return service.decks(owner);
  if (path === "/api/deck-imports/preview" && method === "POST")
    return service.previewDeck(owner, input);
  if (path === "/api/deck-imports" && method === "POST")
    return service.importDeck(owner, input);
  const tag = path.match(/^\/api\/tags\/([^/]+)$/);
  if (tag && method === "PATCH") return service.renameTag(owner, tag[1], input);
  if (tag && method === "DELETE") return service.deleteTag(owner, tag[1]);
  const row = path.match(/^\/api\/collection\/([^/]+)$/);
  if (row && method === "PATCH")
    return service.setQuantity(
      owner,
      decodeURIComponent(row[1]),
      input.quantity,
    );
  if (row && method === "DELETE")
    return service.remove(owner, decodeURIComponent(row[1]));
  if (path === "/api/tag-assignments" && method === "PUT")
    return service.assign(owner, input.inventory_id, input);
  return undefined;
}
