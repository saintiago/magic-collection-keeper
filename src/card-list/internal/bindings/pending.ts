/**
 * Pending-import bindings of CardList
 * (docs/card-list.md#required-interfaces-and-source-bindings, docs/user-cards.md#import-and-capture-state).
 *
 * One import's pending entries are one bounded list over the UserCards contract: the provider owns
 * the import identity, its capture order and the continuation of its entries, and Catalog supplies
 * the printing and card information a presented entry names. The binding keeps the provider records
 * its reads produced, so a page that reviews an entry reads the record under the entry's own key
 * instead of composing the list read itself. A continuation the provider rejected as stale restarts
 * the sequence, and an entry the catalog does not publish stays explicitly unresolved rather than
 * presenting another card's information.
 */

import type { Catalog, CardRecord, PrintingRecord } from '../../../catalog/index.js';
import type {
  ImportEntry,
  ImportEntryListResult,
  ImportSession,
  ListImportEntriesOptions,
} from '../../../usercards/index.js';

import { CARD_LIST_LIMITS } from '../limits.js';
import type {
  CardListEntry,
  CardListSource,
  CardListSourceRequest,
  CardListTarget,
} from '../contract.js';
import { cardListEntryKey } from './query.js';
import { isInvalidatedContinuation } from './read-failure.js';
import { resolveCards, resolvePrintings } from './catalog.js';

/** The pending-entry read a list binding consumes. */
export interface CardListPendingEntriesRead {
  /** One bounded page of one import's pending entries, in capture order. */
  entries(input: ListImportEntriesOptions, signal?: AbortSignal): Promise<ImportEntryListResult>;
}

/** One pending entry as the list and the page reviewing it present it. */
export interface CardListPendingRecord {
  readonly entry: ImportEntry;
  /** Printing the entry names, or null while it is unresolved. */
  readonly printing: PrintingRecord | null;
  /** Card of that printing, or null while the entry is unresolved. */
  readonly card: CardRecord | null;
}

/**
 * One import's pending-entry list: its source, the provider records the last reads produced and the
 * session page the provider reported. The page keeps the drafts and operation presentation.
 */
export interface CardListPendingEntries {
  /** The list source of one import's pending entries; the list context is the import identity. */
  readonly source: CardListSource<string>;
  /** The record of one entry in the current read sequence, or null when it is not held. */
  record(key: string): CardListPendingRecord | null;
  /** Key of every pending entry this binding still holds a record for. */
  keys(): readonly string[];
  /** Pending import the last read answered with, or null before one answered. */
  session(): ImportSession | null;
}

/**
 * Builds the pending-entry binding over one account's import reads and Catalog. The binding holds
 * the records its own reads resolved, bounded like the list's working window.
 */
export function pendingEntriesBinding(options: {
  readonly entries: CardListPendingEntriesRead;
  readonly catalog: Catalog;
}): CardListPendingEntries {
  const read = options?.entries;
  if (typeof read?.entries !== 'function') {
    throw new TypeError('The pending entries are read through the UserCards contract.');
  }
  const catalog = options?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('The pending entries resolve their printings through Catalog.');
  }
  const records = new Map<string, CardListPendingRecord>();
  let session: ImportSession | null = null;

  return {
    source: {
      // A change naming the presented import, or of the public catalog, may change its entries; a
      // change of another import or of the account's copies reacquires nothing here.
      affects: (change, presented) =>
        change.imports.includes(presented) || change.scope === 'catalog',
      async load(request: CardListSourceRequest<string>) {
        let page: ImportEntryListResult;
        try {
          page = await read.entries(
            {
              sessionId: request.context,
              pageSize: request.pageSize,
              ...(request.continuation === null ? {} : { continuation: request.continuation }),
            },
            request.signal,
          );
        } catch (cause) {
          if (request.continuation !== null && isInvalidatedContinuation(cause)) {
            // The import's private revision changed after the continuation was read: the list
            // restarts the pending entries instead of repeating a continuation the provider keeps
            // refusing (docs/user-cards.md#interface).
            return { status: 'invalidated' };
          }
          throw cause;
        }
        request.signal.throwIfAborted();
        const resolved = await resolvePendingRecords(catalog, page.entries, request.signal);
        request.signal.throwIfAborted();
        // A replacement establishes a new sequence. Historical records and selected revisions
        // cannot establish that an omitted entry still exists in the pending result.
        if (request.continuation === null) records.clear();
        for (const record of resolved) {
          const key = pendingEntryKey(record.entry);
          records.delete(key);
          records.set(key, record);
        }
        boundRecords(records);
        session = page.session;
        return {
          status: 'page',
          entries: resolved.map((record) => pendingListEntry(record)),
          continuation: page.continuation,
          // The provider's own read is authoritative for the pending entries it returns.
        };
      },
    },
    record(key) {
      return records.get(key) ?? null;
    },
    keys() {
      return [...records.keys()];
    },
    session() {
      return session;
    },
  };
}

/** One pending entry as the list protocol presents it, with the catalog record it names. */
export function pendingListEntry(record: CardListPendingRecord): CardListEntry {
  const printing = record.printing;
  return {
    key: pendingEntryKey(record.entry),
    target: { kind: 'pending', entryId: record.entry.entryId },
    // The reviewed quantity is pending input, not an owned copy count, so the entry carries no
    // quantity context; the review presents its own value (docs/user-cards.md#import-state).
    quantity: null,
    basic:
      record.card === null
        ? null
        : {
            card: {
              cardId: record.card.cardId,
              name: record.card.name,
              matchedName: null,
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
  };
}

/** Stable key of one pending entry, taken from its own identity. */
export function pendingEntryKey(entry: ImportEntry): string {
  return cardListEntryKey({ kind: 'pending', entryId: entry.entryId } satisfies CardListTarget);
}

/** Resolves the printings and cards the pending entries name through Catalog. */
async function resolvePendingRecords(
  catalog: Catalog,
  entries: readonly ImportEntry[],
  signal: AbortSignal,
): Promise<readonly CardListPendingRecord[]> {
  const printingIds = entries.flatMap((entry) =>
    entry.printingId === null ? [] : [entry.printingId],
  );
  const printings = await resolvePrintings(catalog, printingIds);
  signal.throwIfAborted();
  const cardIds = [
    ...new Set([
      ...[...printings.values()].map((printing) => printing.cardId),
      // A card-level review names its playable identity without a printing; a printing entry
      // reads its card through the printing it resolved.
      ...entries.flatMap((entry) =>
        entry.printingId === null && entry.cardId !== null ? [entry.cardId] : [],
      ),
    ]),
  ];
  const cards = await resolveCards(catalog, cardIds);
  return entries.map((entry) => {
    const printing = entry.printingId === null ? null : (printings.get(entry.printingId) ?? null);
    const cardId = printing?.cardId ?? (entry.printingId === null ? entry.cardId : null);
    const card = cardId === null ? null : (cards.get(cardId) ?? null);
    return { entry, printing, card };
  });
}

/** Each binding keeps one working window of provider records, like the list it serves. */
function boundRecords(records: Map<string, CardListPendingRecord>): void {
  for (const key of [...records.keys()].slice(0, -CARD_LIST_LIMITS.window)) {
    records.delete(key);
  }
}
