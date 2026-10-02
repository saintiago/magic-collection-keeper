import {
  CATALOG_LIMITS,
  CatalogError,
  type CatalogResolver,
  type CatalogReference,
  type CatalogResolution,
  type CardRecord,
  type Finish,
  type PrintingRecord,
} from '../../catalog/contract.js';
import { UserCardsError } from './errors.js';

/** A catalog read failure is a temporary failure, never a missing reference. */
export async function resolveCatalog(
  catalog: CatalogResolver,
  references: readonly CatalogReference[],
): Promise<CatalogResolution> {
  try {
    return await catalog.resolve(references);
  } catch (cause) {
    if (cause instanceof CatalogError) {
      throw new UserCardsError(
        'unavailable',
        'The catalog could not be read to validate the reference.',
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Resolves the distinct printings of one request in catalog reads that never exceed the provider's
 * published resolution bound, so a valid staging batch is resolved completely instead of failing as
 * a temporary catalog failure. A reference the published revision does not contain stays absent
 * from the result instead of failing the read, so a source line the catalog cannot resolve remains
 * reviewable (docs/user-cards.md#source-imports).
 */
export async function resolveAvailablePrintings(
  catalog: CatalogResolver,
  printingIds: readonly string[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const distinct = [...new Set(printingIds)];
  if (distinct.length === 0) {
    return new Map();
  }
  const printings = new Map<string, PrintingRecord>();
  for (let start = 0; start < distinct.length; start += CATALOG_LIMITS.maxResolutionReferences) {
    const batch = distinct.slice(start, start + CATALOG_LIMITS.maxResolutionReferences);
    const resolution = await resolveCatalog(
      catalog,
      batch.map((printingId) => ({ kind: 'printing', printingId }) as const),
    );
    for (const printingId of batch) {
      const printing = resolution.printings.get(printingId);
      if (printing !== undefined) {
        printings.set(printingId, printing);
      }
    }
  }
  return printings;
}

/**
 * Resolves the distinct cards of one request; a reference the published revision does not contain
 * is a missing reference, because a reviewed card identity is always a published one
 * (docs/user-cards.md#records-and-associations).
 */
export async function resolveCards(
  catalog: CatalogResolver,
  cardIds: readonly string[],
): Promise<ReadonlyMap<string, CardRecord>> {
  const distinct = [...new Set(cardIds)];
  const cards = new Map<string, CardRecord>();
  for (let start = 0; start < distinct.length; start += CATALOG_LIMITS.maxResolutionReferences) {
    const batch = distinct.slice(start, start + CATALOG_LIMITS.maxResolutionReferences);
    const resolution = await resolveCatalog(
      catalog,
      batch.map((cardId) => ({ kind: 'card', cardId }) as const),
    );
    for (const cardId of batch) {
      const card = resolution.cards.get(cardId);
      if (card !== undefined) {
        cards.set(cardId, card);
      }
    }
  }
  for (const cardId of distinct) {
    if (!cards.has(cardId)) {
      throw new UserCardsError('not-found', 'The card is not available in the catalog.');
    }
  }
  return cards;
}

/**
 * Resolves the distinct printings of one request; a reference the published revision does not
 * contain is a missing reference, because the component never stores one
 * (docs/user-cards.md#records-and-associations).
 */
export async function resolvePrintings(
  catalog: CatalogResolver,
  printingIds: readonly string[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const distinct = [...new Set(printingIds)];
  const printings = await resolveAvailablePrintings(catalog, distinct);
  for (const printingId of distinct) {
    if (!printings.has(printingId)) {
      throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
    }
  }
  return printings;
}

/**
 * Pending input retains its requested finish without requiring physical eligibility. When no
 * finish was supplied, suggest the first physical finish if one exists. Only an ownership action
 * validates physical attributes (docs/user-cards.md#import-and-capture-state).
 */
export function pendingFinish(printing: PrintingRecord, requested: Finish | null): Finish | null {
  return requested ?? (printing.physical ? (printing.finishes[0] ?? null) : null);
}

/** The finish a physical copy carries must be offered by a physically available printing. */
export function physicalFinish(printing: PrintingRecord, requested: Finish | null): Finish {
  if (!printing.physical) {
    throw new UserCardsError(
      'invalid-request',
      'The printing is not available as a physical card.',
    );
  }
  if (requested !== null && !printing.finishes.includes(requested)) {
    throw new UserCardsError(
      'invalid-request',
      `The printing is not available in the ${requested} finish.`,
    );
  }
  const finish = requested ?? printing.finishes[0];
  if (finish === undefined) {
    throw new UserCardsError(
      'invalid-request',
      'The printing offers no finish a physical copy could carry.',
    );
  }
  return finish;
}

/** Resolves one printing and the finish a physical copy of it carries. */
export async function resolvePhysicalPrinting(
  catalog: CatalogResolver,
  printingId: string,
  requested: Finish | null,
): Promise<{ readonly printing: PrintingRecord; readonly finish: Finish }> {
  const printings = await resolvePrintings(catalog, [printingId]);
  const printing = printings.get(printingId);
  if (printing === undefined) {
    throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
  }
  return { printing, finish: physicalFinish(printing, requested) };
}
