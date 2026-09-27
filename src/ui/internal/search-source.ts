/**
 * Catalog search adapters of the UserInterface
 * (docs/user-interface.md#browsing-and-organization, docs/search.md#scryfall-compatibility).
 *
 * The catalog page presents one query through the list boundary: the page's text expression and
 * its structured controls build one Search request, so a supported expression and the equivalent
 * control select the same entries through the same query model, and the opaque continuation of a
 * page returns unchanged, so the next page belongs to the query that produced it. Every entry
 * keeps its typed target, basic information and quantity context, and the images fragment of a
 * printing entry is read through Catalog separately from that basic information, so a missing or
 * failed image never changes which entries the result holds.
 */

import type { SearchClient } from '../../application/index.js';
import type { Catalog, Finish, PrintingRecord, PrintingReference } from '../../catalog/index.js';
import type {
  SearchCount,
  SearchCountReference,
  SearchCriterion,
  SearchEntry,
  SearchPage,
  SearchRequestInput,
} from '../../search/index.js';

import type { UiEntryImage, UiEntryOwnership } from './card-list.js';
import type { UiEntryTarget, UiFragmentReader, UiListEntry, UiListSource } from './list.js';
import type { UiCatalogLevel, UiCollectionLevel } from './routes.js';

/** One catalog query: the text expression and the structured controls the page presents. */
export interface UiCatalogQuery {
  /** Scryfall-compatible text expression; empty browses the whole catalog. */
  readonly text: string;
  readonly level: UiCatalogLevel;
  /** Whether the account must own the physical copies the entry represents. */
  readonly owned: boolean;
  /** Required printing finish, or null when the query does not constrain it. */
  readonly finish: Finish | null;
}

/**
 * One collection query: the text expression and the level of the account's owned records the
 * collection view presents. The owned membership is not a control of this query — every collection
 * entry is owned — so the adapter always evaluates it as the private criterion it is.
 */
export interface UiCollectionQuery {
  /** Scryfall-compatible text expression; empty presents every owned entry of the level. */
  readonly text: string;
  readonly level: UiCollectionLevel;
}

/**
 * One Search request for a catalog query and a page boundary. The controls become structured
 * criteria and the text expression stays one expression, so Search normalizes both into the same
 * query model; the continuation names the page of the query that produced it.
 */
export function catalogSearchRequest(
  query: UiCatalogQuery,
  pageSize: number,
  continuation: string | null,
): SearchRequestInput {
  const criteria: SearchCriterion[] = [];
  if (query.owned) {
    criteria.push({ kind: 'owned' });
  }
  if (query.finish !== null) {
    criteria.push({ kind: 'finish', finish: query.finish });
  }
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text.length === 0 ? {} : { query: text }),
    ...(criteria.length === 0 ? {} : { criteria }),
    pageSize,
    ...(continuation === null ? {} : { continuation }),
  };
}

/**
 * One Search request for a collection query and a page boundary: the text expression stays one
 * expression beside the owned criterion, so Search normalizes it into the same query model a
 * catalog query with the owned control uses, and the opaque continuation names the page of the
 * account-scoped query that produced it.
 */
export function collectionSearchRequest(
  query: UiCollectionQuery,
  pageSize: number,
  continuation: string | null,
): SearchRequestInput {
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text.length === 0 ? {} : { query: text }),
    criteria: [{ kind: 'owned' }],
    pageSize,
    ...(continuation === null ? {} : { continuation }),
  };
}

/**
 * Key of one presented entry: its level and its provider identity. The list boundary keeps
 * interaction state under it, and a fragment read names the entry's printing from the key alone,
 * so the images reader holds no state beside the presented window.
 */
export function uiEntryKey(target: UiEntryTarget): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `${printingKeyPrefix}${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
    case 'pending':
      return `pending:${target.entryId}`;
  }
}

/** The typed target one entry key names, or null when the key names no entry of this level. */
export function uiEntryTargetOfKey(key: string): UiEntryTarget | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  const identity = key.slice(separator + 1);
  switch (key.slice(0, separator)) {
    case 'card':
      return { kind: 'card', cardId: identity };
    case 'printing':
      return { kind: 'printing', printingId: identity };
    case 'copy':
      return { kind: 'copy', copyId: identity };
    case 'pending':
      return { kind: 'pending', entryId: identity };
    default:
      return null;
  }
}

/**
 * Private counts of one presented entry: the account's owned copies of it, the distinct physical
 * locations holding those copies, and the intended quantity one tag associates with it
 * (docs/user-interface.md#browsing-and-organization, docs/search.md#request-and-result).
 */
export interface UiEntryCounts {
  readonly owned: number;
  readonly locations: number;
  readonly intended: number | null;
}

/**
 * Reads the private counts of explicit presented entries through the Search contract. A page asks
 * for the entries it presents in one bounded read, so enriching a result never changes which
 * entries its query selected and an unowned entry keeps its place with an exact zero.
 */
export interface UiCountsAccess {
  /** Counts of the requested entries keyed by entry key; a failed read rejects as one batch. */
  ofBatch(
    targets: readonly UiEntryTarget[],
    tagId: string | null,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, UiEntryCounts>>;
}

/** Builds the counts access over the Search contract. */
export function createSearchCounts(search: SearchClient): UiCountsAccess {
  if (typeof search?.counts !== 'function') {
    throw new TypeError('The organization views read private counts through Search.');
  }
  return {
    async ofBatch(targets, tagId, signal) {
      if (targets.length === 0) {
        return new Map();
      }
      const result = await search.counts(
        {
          references: targets.map((target) => referenceOfTarget(target)),
          ...(tagId === null ? {} : { tagId }),
        },
        signal,
      );
      return new Map([...result.counts].map(([key, count]) => [key, readCount(count)] as const));
    },
  };
}

function referenceOfTarget(target: UiEntryTarget): SearchCountReference {
  switch (target.kind) {
    case 'card':
      return { kind: 'card', cardId: target.cardId };
    case 'printing':
      return { kind: 'printing', printingId: target.printingId };
    case 'copy':
      return { kind: 'copy', copyId: target.copyId };
    case 'pending':
      // Pending import entries are excluded from every ownership count, so Search has no
      // reference for them (docs/user-cards.md#import-and-capture-state).
      throw new TypeError('A pending import entry carries no private count reference.');
  }
}

function readCount(count: SearchCount): UiEntryCounts {
  return { owned: count.owned, locations: count.locations, intended: count.intended };
}

/**
 * Ownership fragment of a list whose entry keys name card, printing or copy targets directly: the
 * entries' own keys are the references the counts read answers. A failed count read fails the
 * fragment, so an unavailable count is never presented as zero.
 */
export function createEntryOwnershipReader(
  counts: UiCountsAccess,
  referenceOfKey: (key: string) => UiEntryTarget | null = uiEntryTargetOfKey,
  tagId: () => string | null = () => null,
): UiFragmentReader<UiEntryOwnership> {
  return {
    async read(request) {
      const references = new Map<string, UiEntryTarget>();
      for (const key of request.keys) {
        const target = referenceOfKey(key);
        if (target !== null) {
          references.set(key, target);
        }
      }
      const read = await counts.ofBatch([...references.values()], tagId(), request.signal);
      return request.keys.map((key) => {
        const target = references.get(key) ?? null;
        const count = target === null ? undefined : read.get(uiEntryKey(target));
        return count === undefined
          ? { key, status: 'absent' as const, values: null }
          : {
              key,
              status: 'ready' as const,
              values: {
                owned: count.owned,
                locations: count.locations,
                intended: count.intended,
              } satisfies UiEntryOwnership,
            };
      });
    },
  };
}

/** One Search entry as the list boundary presents it. */
export function searchListEntry(entry: SearchEntry): UiListEntry {
  const printing = entry.printing;
  return {
    key: uiEntryKey(entry.target),
    target: entry.target,
    basic: {
      card: {
        cardId: entry.card.cardId,
        name: entry.card.name,
        matchedName: entry.card.matchedName,
      },
      printing:
        printing === null
          ? null
          : {
              printingId: printing.printingId,
              edition: printing.edition,
              collectorNumber: printing.collectorNumber,
              language: printing.language,
            },
    },
    quantity: entry.quantity,
  };
}

/** One catalog result's data access: the list source and the fragments read over its entries. */
export interface UiCatalogSearchAccess {
  readonly source: UiListSource<UiCatalogQuery>;
  /** Images of the printings the presented entries represent, read through Catalog. */
  readonly images: UiFragmentReader<readonly UiEntryImage[]>;
}

/** One collection result's data access: the owned-record list source and its printing images. */
export interface UiCollectionSearchAccess {
  readonly source: UiListSource<UiCollectionQuery>;
  /** Images of the printings the presented entries represent, read through Catalog. */
  readonly images: UiFragmentReader<readonly UiEntryImage[]>;
}

/** Builds the list source and fragment readers of one catalog page over the supplied contracts. */
export function createCatalogSearchAccess(
  search: SearchClient,
  catalog: Catalog,
): UiCatalogSearchAccess {
  if (typeof search?.execute !== 'function') {
    throw new TypeError('The catalog page reads its results through the Search contract.');
  }
  return {
    source: createSearchSource(search, catalogSearchRequest),
    images: createPrintingImagesReader(catalog),
  };
}

/** Builds the owned-record list source and images reader of the collection view. */
export function createCollectionSearchAccess(
  search: SearchClient,
  catalog: Catalog,
): UiCollectionSearchAccess {
  if (typeof search?.execute !== 'function') {
    throw new TypeError('The collection page reads its results through the Search contract.');
  }
  return {
    source: createSearchSource(search, collectionSearchRequest),
    images: createPrintingImagesReader(catalog),
  };
}

/**
 * One Search-backed list source: the adapter builds the request of its own presentation contract
 * and keeps the provider's answer, so the list presents the membership, ordering and continuation
 * Search evaluated rather than reconstructing them.
 */
function createSearchSource<Context>(
  search: SearchClient,
  build: (context: Context, pageSize: number, continuation: string | null) => SearchRequestInput,
): UiListSource<Context> {
  return {
    async load(request) {
      const page = readSearchPage(
        await search.execute(
          build(request.context, request.pageSize, request.continuation),
          request.signal,
        ),
      );
      return {
        entries: page.entries.map((entry) => searchListEntry(entry)),
        continuation: page.continuation,
      };
    },
  };
}

/**
 * Images of one printing entry, read through Catalog in the bounded batch the list asks for. A
 * printing the catalog does not publish has no image (`absent`); a failed read fails the whole
 * batch, so the list keeps the failure distinguishable from a printing without an image and can
 * retry it.
 */
export function createPrintingImagesReader(
  catalog: Catalog,
): UiFragmentReader<readonly UiEntryImage[]> {
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('Printing images are read through the Catalog contract.');
  }
  return {
    async read(request) {
      const references: PrintingReference[] = [];
      for (const key of request.keys) {
        const printingId = printingIdOfEntryKey(key);
        if (printingId !== null) {
          references.push({ kind: 'printing', printingId });
        }
      }
      const resolution = references.length === 0 ? null : await catalog.resolve(references);
      return request.keys.map((key) => {
        const printingId = printingIdOfEntryKey(key);
        const printing = printingId === null ? undefined : resolution?.printings.get(printingId);
        const image = printing === undefined ? null : printingImage(printing);
        return image === null
          ? { key, status: 'absent' as const, values: null }
          : { key, status: 'ready' as const, values: [image] };
      });
    },
  };
}

/** Prefix of a printing entry's key, which the images reader names its printing back from. */
const printingKeyPrefix = 'printing:';

/** Printing identity one presented entry key carries, or null when it names another level. */
function printingIdOfEntryKey(key: string): string | null {
  if (!key.startsWith(printingKeyPrefix) || key.length === printingKeyPrefix.length) {
    return null;
  }
  return key.slice(printingKeyPrefix.length);
}

/** One visible image of a printing; the presentation shows a named image with its source. */
function printingImage(printing: PrintingRecord): UiEntryImage | null {
  const src =
    printing.images.normal ??
    printing.images.small ??
    printing.images.large ??
    printing.images.artCrop;
  return src === null
    ? null
    : { src, alt: `${printing.edition} ${printing.collectorNumber} · ${printing.language}` };
}

/** The page one Search contract returned; an answer without entries is not a page. */
function readSearchPage(value: unknown): SearchPage {
  const page = value as SearchPage | null | undefined;
  if (typeof page !== 'object' || page === null || !Array.isArray(page.entries)) {
    throw new TypeError('The Search contract returned no page of entries.');
  }
  return page;
}
