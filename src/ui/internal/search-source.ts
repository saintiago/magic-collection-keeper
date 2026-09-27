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
  SearchCriterion,
  SearchEntry,
  SearchPage,
  SearchRequestInput,
} from '../../search/index.js';

import type { UiEntryImage } from './card-list.js';
import type { UiEntryTarget, UiFragmentReader, UiListEntry, UiListSource } from './list.js';
import type { UiCatalogLevel } from './routes.js';

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
  }
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

/** Builds the list source and fragment readers of one catalog page over the supplied contracts. */
export function createCatalogSearchAccess(
  search: SearchClient,
  catalog: Catalog,
): UiCatalogSearchAccess {
  if (typeof search?.execute !== 'function') {
    throw new TypeError('The catalog page reads its results through the Search contract.');
  }
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('Printing images are read through the Catalog contract.');
  }
  return {
    source: {
      async load(request) {
        const page = readSearchPage(
          await search.execute(
            catalogSearchRequest(request.context, request.pageSize, request.continuation),
            request.signal,
          ),
        );
        return {
          entries: page.entries.map((entry) => searchListEntry(entry)),
          continuation: page.continuation,
        };
      },
    },
    images: createPrintingImagesReader(catalog),
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
