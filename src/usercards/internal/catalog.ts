import {
  CATALOG_LIMITS,
  CatalogError,
  type Catalog,
  type CatalogReference,
  type CatalogResolution,
  type Finish,
  type PrintingRecord,
} from '../../catalog/index.js';
import { UserCardsError } from './errors.js';

/** A catalog read failure is a temporary failure, never a missing reference. */
export async function resolveCatalog(
  catalog: Catalog,
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
 * a temporary catalog failure. A reference the catalog does not publish is a missing reference: the
 * component never stores one (docs/user-cards.md#records-and-associations).
 */
export async function resolvePrintings(
  catalog: Catalog,
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
      if (printing === undefined) {
        throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
      }
      printings.set(printingId, printing);
    }
  }
  return printings;
}

/**
 * The finish a stored record carries: the requested finish, or the printing's first offered finish
 * when the caller left it open. The printing must be available as a physical card and offer the
 * finish, so no record carries an attribute the catalog does not publish.
 */
export function physicalFinish(
  printing: PrintingRecord,
  requested: Finish | null | undefined,
): Finish {
  if (!printing.physical) {
    throw new UserCardsError(
      'invalid-request',
      'The printing is not available as a physical card.',
    );
  }
  if (requested !== null && requested !== undefined) {
    if (!printing.finishes.includes(requested)) {
      throw new UserCardsError(
        'invalid-request',
        `The printing is not available in the ${requested} finish.`,
      );
    }
    return requested;
  }
  const offered = printing.finishes[0];
  if (offered === undefined) {
    throw new UserCardsError(
      'invalid-request',
      'The printing offers no finish a physical copy could carry.',
    );
  }
  return offered;
}

/** Resolves one printing and the finish a physical copy of it carries. */
export async function resolvePhysicalPrinting(
  catalog: Catalog,
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
