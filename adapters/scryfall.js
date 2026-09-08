import { ApplicationError } from "../domain/inventory.js";
export function createScryfallCatalog({ cache, rateLimit, fetcher = fetch }) {
  async function search(query, page, discovery = false) {
    const key = JSON.stringify(
      discovery ? ["discovery-en-v1", query, page] : [query, page],
    );
    const cached = await cache.get(key);
    if (cached) return cached;
    await rateLimit.acquire();
    const params = new URLSearchParams({
      q: `(${query}) game:paper${discovery ? " lang:en" : ""}`,
      unique: discovery ? "cards" : "prints",
      include_multilingual: String(!discovery),
      order: "name",
      page: String(page),
    });
    const response = await fetcher(
      `https://api.scryfall.com/cards/search?${params}`,
      {
        headers: {
          "User-Agent": "MagicCollectionKeeper/0.1",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    if (response.status === 404) return { cards: [], total: 0, hasMore: false };
    if (response.status === 429)
      await rateLimit.pause(
        Math.max(
          60000,
          Number(response.headers.get("retry-after") || 60) * 1000,
        ),
      );
    if (!response.ok)
      throw new ApplicationError(
        data.details || "Scryfall is unavailable. Please try again.",
        response.status,
      );
    const result = {
      cards: data.data,
      total: data.total_cards,
      hasMore: data.has_more,
    };
    await cache.put(key, result);
    return result;
  }
  return {
    async resolve(ids) {
      const cards = [];
      const unique = [...new Set(ids)].sort();
      for (let start = 0; start < unique.length; start += 75) {
        const batch = unique.slice(start, start + 75);
        const key = JSON.stringify(["printing-collection", batch]);
        const cached = await cache.get(key);
        if (cached) {
          cards.push(...cached.cards);
          continue;
        }
        await rateLimit.acquire();
        let response;
        try {
          response = await fetcher(
            "https://api.scryfall.com/cards/collection",
            {
              method: "POST",
              headers: {
                "User-Agent": "MagicCollectionKeeper/0.1",
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                identifiers: batch.map((id) => ({ id })),
              }),
              signal: AbortSignal.timeout(10000),
            },
          );
        } catch {
          throw new ApplicationError(
            "Printing verification timed out. Retry; the saved draft is unchanged.",
            502,
          );
        }
        if (response.status === 429)
          await rateLimit.pause(
            Math.max(
              60000,
              Number(response.headers.get("retry-after") || 60) * 1000,
            ),
          );
        if (!response.ok)
          throw new ApplicationError(
            "Printing verification is unavailable. Retry later.",
            response.status,
          );
        const data = await response.json();
        if (!Array.isArray(data.data))
          throw new ApplicationError(
            "Printing verification returned an unreadable response.",
            502,
          );
        const result = {
          cards: data.data,
          total: data.data.length,
          hasMore: false,
        };
        await cache.put(key, result);
        cards.push(...result.cards);
      }
      return cards;
    },
    search: (query, page) => search(query, page),
    discover: async (query, page) => {
      const result = await search(query, page, true);
      const seen = new Set();
      return {
        ...result,
        cards: result.cards
          .filter(
            (card) =>
              card.lang === "en" &&
              !seen.has(card.oracle_id) &&
              seen.add(card.oracle_id),
          )
          .map((card) => ({ ...card, discovery: {} })),
      };
    },
  };
}
