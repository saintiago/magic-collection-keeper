import { ApplicationError, validateSearch } from "../domain/inventory.js";

export function createDiscoveryService({ names, catalog }) {
  const cache = new Map(),
    pending = new Map();
  async function cached(key, action) {
    if (cache.has(key) && Date.now() < cache.get(key).expires)
      return cache.get(key).value;
    if (!pending.has(key))
      pending.set(
        key,
        action()
          .then((value) => {
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(key, { value, expires: Date.now() + 86400000 });
            return value;
          })
          .finally(() => pending.delete(key)),
      );
    return pending.get(key);
  }
  return {
    async suggest(query) {
      validateSearch(query, 1);
      if (query.includes(":")) return { suggestions: [], catalog: null };
      const started = performance.now();
      const index = await names.get();
      const loaded = performance.now();
      const suggestions = await cached(
        `${index.metadata.version}:suggest:${query}`,
        async () => index.search.search(query, { suggest: true }).slice(0, 8),
      );
      return {
        suggestions,
        catalog: index.metadata,
        timing: {
          phase: "server-name-search",
          indexWaitMs: loaded - started,
          searchMs: performance.now() - loaded,
        },
      };
    },
    async discover(query, page = 1, oracle = "", printing = "") {
      validateSearch(query, page);
      if (printing) {
        const uuid =
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        if (!uuid.test(printing) || !uuid.test(oracle))
          throw new ApplicationError("Invalid card identity", 400);
        const cards = await cached(`printing:${printing}:${oracle}`, () =>
          catalog.resolve([printing]),
        );
        const card = cards.find(
          (c) =>
            c.id === printing &&
            c.oracle_id === oracle &&
            c.lang === "en" &&
            !c.digital &&
            c.games?.includes("paper"),
        );
        if (!card)
          throw new ApplicationError(
            "This English paper printing could not be verified. Search again.",
            503,
          );
        return { cards: [card], total: 1, hasMore: false, catalog: null };
      }
      if (query.includes(":") && !oracle) return catalog.discover(query, page);
      const index = await names.get();
      const matches = await cached(
        `${index.metadata.version}:names:${query}:${oracle}`,
        async () => {
          if (!oracle) return index.search.search(query);
          const match = index.search.identity(oracle);
          if (!match)
            throw new ApplicationError(
              "This card is unavailable in the current English catalog.",
              404,
            );
          return [match];
        },
      );
      const selected = matches.slice((page - 1) * 24, page * 24);
      const resolved = selected.length
        ? await cached(
            `${index.metadata.version}:cards:${selected.map((m) => m.printing_id).join(",")}`,
            () => catalog.resolve(selected.map((m) => m.printing_id)),
          )
        : [];
      const byId = new Map(
        resolved
          .filter(
            (card) =>
              card.lang === "en" &&
              !card.digital &&
              card.games?.includes("paper"),
          )
          .map((card) => [card.id, card]),
      );
      if (
        selected.some(
          (match) => byId.get(match.printing_id)?.oracle_id !== match.oracle_id,
        )
      )
        throw new ApplicationError(
          "Some catalog cards could not be verified. Retry after the catalog refresh.",
          503,
        );
      return {
        cards: selected.map((match) => ({
          ...byId.get(match.printing_id),
          discovery: {
            matched_name: match.matched_name,
            matched_language: match.matched_language,
          },
        })),
        total: matches.length,
        hasMore: page * 24 < matches.length,
        catalog: index.metadata,
      };
    },
  };
}
