/** Printing selection policy, independent of the Catalog storage implementation. */
import { CatalogError } from './errors.js';
import { CATALOG_LIMITS, type CardRecord, type PrintingRecord } from './model.js';
import type { Catalog } from './service.js';

export interface PrintingLookup {
  readonly cardId: string;
  readonly edition: string | null;
  readonly collectorNumber: string | null;
  readonly language: string | null;
}

/** Exact case-insensitive constraints; unspecified fields do not narrow the match. */
export async function findCatalogPrinting(
  catalog: Catalog,
  lookup: PrintingLookup,
): Promise<{ readonly card: CardRecord; readonly printing: PrintingRecord } | null> {
  for (const [field, value] of Object.entries(lookup)) {
    if (
      value !== null &&
      (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > CATALOG_LIMITS.maxIdentifierLength)
    ) {
      throw new CatalogError('invalid-request', `Invalid printing lookup ${field}.`);
    }
  }
  let continuation: string | null = null;
  let revision: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await catalog.listCardPrintings(lookup.cardId, {
      pageSize: CATALOG_LIMITS.maxPrintingPageSize,
      ...(continuation === null ? {} : { continuation }),
    });
    if (revision !== null && page.revision.revisionId !== revision) {
      throw new CatalogError('stale-continuation', 'The catalog changed during printing lookup.');
    }
    revision = page.revision.revisionId;
    const printing = page.printings.find(
      (candidate) =>
        candidate.cardId === lookup.cardId &&
        (['edition', 'collectorNumber', 'language'] as const).every(
          (field) =>
            lookup[field] === null ||
            candidate[field].toLowerCase() === lookup[field].toLowerCase(),
        ),
    );
    if (printing !== undefined) {
      const resolution = await catalog.resolve([{ kind: 'card', cardId: lookup.cardId }]);
      if (resolution.revision.revisionId !== revision) {
        throw new CatalogError('stale-continuation', 'The catalog changed during printing lookup.');
      }
      const card = resolution.cards.get(lookup.cardId);
      if (card === undefined)
        throw new CatalogError('unavailable', 'The printing has no published card.');
      return { card, printing };
    }
    continuation = page.continuation;
    if (continuation !== null) {
      if (seen.has(continuation))
        throw new CatalogError('unavailable', 'The printing list did not advance.');
      seen.add(continuation);
    }
  } while (continuation !== null);
  return null;
}
