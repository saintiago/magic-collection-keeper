import { ApplicationError } from "../domain/inventory.js";
export function createScryfallCatalog({ cache, rateLimit, fetcher = fetch }) {
  return {
    async search(query, page) {
      const key = JSON.stringify([query, page]);
      const cached = await cache.get(key);
      if (cached) return cached;
      await rateLimit.acquire();
      const params = new URLSearchParams({
        q: `(${query}) game:paper`,
        unique: "prints",
        include_multilingual: "true",
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
      if (response.status === 404)
        return { cards: [], total: 0, hasMore: false };
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
    },
  };
}
