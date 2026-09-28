/**
 * Catalog bindings of CardList (docs/card-list.md#required-interfaces-and-source-bindings,
 * docs/catalog.md#provided-operations).
 *
 * Catalog supplies batched basic information, printing choices and image references. A card's
 * published printings become one bounded list over the Catalog contract; a printing entry's
 * images fragment is read through the same contract in the bounded batch the list asks for, and a
 * printing the catalog does not publish is an explicit absence instead of a failure.
 */

import type {
  Catalog,
  CardPrintingsPage,
  CardRecord,
  PrintingRecord,
  PrintingReference,
} from '../../../catalog/index.js';

import { CARD_LIST_LIMITS } from '../limits.js';
import type {
  CardListEntry,
  CardListEntryImage,
  CardListFragmentReader,
  CardListSource,
} from '../contract.js';
import { isInvalidatedContinuation } from './search.js';

/** Prefix of a printing entry's key, which the images reader names its printing back from. */
const printingKeyPrefix = 'printing:';

/**
 * The published printings of one card as a bounded list source over the Catalog contract. A
 * continuation the catalog republished is reported as an invalidated sequence, so the list reads
 * the printings again from their first page instead of repeating an unusable cursor.
 */
export function cardPrintingsSource(catalog: Catalog, card: CardRecord): CardListSource<string> {
  if (typeof catalog?.listCardPrintings !== 'function') {
    throw new TypeError('The card printings are read through the Catalog contract.');
  }
  return {
    // A published catalog revision changes the printings a list holds; the notifications a
    // consumer forwards reacquire them.
    affects: () => true,
    async load(request) {
      let page: CardPrintingsPage;
      try {
        page = await catalog.listCardPrintings(card.cardId, {
          pageSize: request.pageSize,
          ...(request.continuation === null ? {} : { continuation: request.continuation }),
        });
      } catch (cause) {
        if (request.continuation !== null && isInvalidatedContinuation(cause)) {
          return { status: 'invalidated' };
        }
        throw cause;
      }
      return {
        status: 'page',
        entries: page.printings.map((printing) => printingEntry(card, printing)),
        continuation: page.continuation,
        // The catalog's published printings incorporate the revision the read observed.
        current: true,
      };
    },
  };
}

/** One published printing as the list protocol presents it. */
export function printingEntry(card: CardRecord, printing: PrintingRecord): CardListEntry {
  return {
    key: `${printingKeyPrefix}${printing.printingId}`,
    target: { kind: 'printing', printingId: printing.printingId },
    basic: {
      card: { cardId: card.cardId, name: card.name, matchedName: null },
      printing: {
        printingId: printing.printingId,
        edition: printing.edition,
        collectorNumber: printing.collectorNumber,
        language: printing.language,
      },
    },
    quantity: null,
  };
}

/**
 * Images of one printing entry, read through Catalog in the bounded batch the list asks for. A
 * printing the catalog does not publish has no image (`absent`); a failed read fails the whole
 * batch, so the list keeps the failure distinguishable from a printing without an image and can
 * retry it.
 */
export function printingImagesReader(
  catalog: Catalog,
): CardListFragmentReader<readonly CardListEntryImage[]> {
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

/** Printing identity one presented entry key carries, or null when it names another level. */
export function printingIdOfEntryKey(key: string): string | null {
  if (!key.startsWith(printingKeyPrefix) || key.length === printingKeyPrefix.length) {
    return null;
  }
  return key.slice(printingKeyPrefix.length);
}

/** One visible image of a printing; the presentation shows a named image with its source. */
function printingImage(printing: PrintingRecord): CardListEntryImage | null {
  const src =
    printing.images.normal ??
    printing.images.small ??
    printing.images.large ??
    printing.images.artCrop;
  return src === null
    ? null
    : { src, alt: `${printing.edition} ${printing.collectorNumber} · ${printing.language}` };
}

/** Printings of explicit identities, resolved through Catalog in bounded batches. */
export async function resolvePrintings(
  catalog: Catalog,
  printingIds: readonly string[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const printings = new Map<string, PrintingRecord>();
  for (const batch of batches([...new Set(printingIds)])) {
    const resolution = await catalog.resolve(
      batch.map((printingId) => ({ kind: 'printing' as const, printingId })),
    );
    for (const printing of resolution.printings.values()) {
      printings.set(printing.printingId, printing);
    }
  }
  return printings;
}

/** Cards of explicit identities, resolved through Catalog in bounded batches. */
export async function resolveCards(
  catalog: Catalog,
  cardIds: readonly string[],
): Promise<ReadonlyMap<string, CardRecord>> {
  const cards = new Map<string, CardRecord>();
  for (const batch of batches([...new Set(cardIds)])) {
    const resolution = await catalog.resolve(
      batch.map((cardId) => ({ kind: 'card' as const, cardId })),
    );
    for (const card of resolution.cards.values()) {
      cards.set(card.cardId, card);
    }
  }
  return cards;
}

function batches(ids: readonly string[]): readonly (readonly string[])[] {
  const bound = CARD_LIST_LIMITS.resolveBatch;
  const read: string[][] = [];
  for (let index = 0; index < ids.length; index += bound) {
    read.push(ids.slice(index, index + bound));
  }
  return read;
}
