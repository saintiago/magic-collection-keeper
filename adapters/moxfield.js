import { ApplicationError, validateQuantity } from "../domain/inventory.js";
import { MAX_DRAFT_ROWS, moxfieldSource } from "../domain/import-draft.js";

export function parseMoxfieldDeck(source, data) {
  if (
    typeof data?.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 100 ||
    (data.publicId && data.publicId !== source.source_id)
  )
    throw new ApplicationError("Moxfield returned an unreadable deck.", 502);
  if (data.isPrivate || data.isPasswordProtected)
    throw new ApplicationError(
      "Private or password-protected Moxfield decks cannot be imported.",
      403,
    );
  const rows = [],
    excluded = [];
  const boards =
    data.boards ||
    Object.fromEntries(
      [
        "mainboard",
        "commanders",
        "companions",
        "sideboard",
        "maybeboard",
        "tokens",
      ]
        .filter((key) => data[key])
        .map((key) => [key, { cards: data[key] }]),
    );
  for (const [section, board] of Object.entries(boards)) {
    const lines = Object.values(board?.cards || {});
    if (!["mainboard", "commanders", "companions"].includes(section)) {
      excluded.push({
        section: section.slice(0, 40),
        quantity: lines.reduce((n, r) => n + (Number(r.quantity) || 0), 0),
      });
      continue;
    }
    for (const [index, line] of lines.entries()) {
      validateQuantity(line.quantity);
      const card = line.card;
      if (!card || typeof card.name !== "string" || card.name.length > 200)
        throw new ApplicationError(
          "Moxfield returned an unreadable card line.",
          502,
        );
      rows.push({
        source_line: `${section}:${index}`,
        section,
        name: card.name,
        quantity: line.quantity,
        printing_id: /^[a-f0-9-]{36}$/.test(card.scryfall_id || "")
          ? card.scryfall_id
          : null,
        finish:
          line.finish === "etched"
            ? "etched"
            : line.finish === "foil" || line.isFoil
              ? "foil"
              : "nonfoil",
        set: String(card.set || "").slice(0, 20),
        collector_number: String(card.cn || card.collector_number || "").slice(
          0,
          40,
        ),
        language: String(card.lang || "en").slice(0, 10),
      });
    }
  }
  if (!rows.length || rows.length > MAX_DRAFT_ROWS)
    throw new ApplicationError(
      "Import a deck containing 1–150 mainboard, commander and companion lines.",
    );
  return {
    ...source,
    name: data.name.trim(),
    rows,
    excluded,
    retrieved_at: new Date().toISOString(),
  };
}
export function createMoxfieldProvider({
  fetcher = fetch,
  rateLimit,
  userAgent = "MagicCollectionKeeper/0.1 (+https://github.com/saintiago/magic-collection-keeper)",
} = {}) {
  return {
    async fetchDeck(url) {
      const source = moxfieldSource(url);
      await rateLimit?.acquire();
      let response;
      try {
        response = await fetcher(
          `https://api2.moxfield.com/v3/decks/all/${source.source_id}`,
          {
            headers: { Accept: "application/json", "User-Agent": userAgent },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
      } catch {
        throw new ApplicationError(
          "Moxfield could not be reached within the time limit. Your saved draft is unchanged. Retry later.",
          502,
        );
      }
      if (response.status === 429) {
        await rateLimit?.pause(60000);
        throw new ApplicationError(
          "Moxfield is limiting requests. Wait a minute and retry; your draft is unchanged.",
          429,
        );
      }
      if ([401, 403].includes(response.status))
        throw new ApplicationError(
          "Moxfield denied this server access. Public URL imports require approved Moxfield access; private or password-protected decks are not supported. Your saved draft is unchanged.",
          403,
        );
      if (response.status === 404)
        throw new ApplicationError(
          "Moxfield could not find an accessible deck at that link. Your saved draft is unchanged.",
          404,
        );
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("application/json")
      )
        throw new ApplicationError(
          "Moxfield returned an unavailable or unreadable response. Your saved draft is unchanged.",
          502,
        );
      const reader = response.body.getReader();
      let bytes = 0,
        chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 2000000)
            throw new ApplicationError(
              "Moxfield's response is too large for a single draft.",
              413,
            );
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          "Moxfield's response was interrupted. Your saved draft is unchanged. Retry later.",
          502,
        );
      } finally {
        await reader.cancel().catch(() => {});
      }
      let data;
      try {
        data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      } catch {
        throw new ApplicationError(
          "Moxfield returned an unreadable deck.",
          502,
        );
      }
      return parseMoxfieldDeck(source, data);
    },
  };
}
