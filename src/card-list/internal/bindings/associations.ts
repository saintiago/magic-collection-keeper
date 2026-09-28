/**
 * Tag-association bindings of CardList
 * (docs/card-list.md#required-interfaces-and-source-bindings, docs/user-cards.md#records-and-associations).
 *
 * One tag's associations are one bounded list over the UserCards contract: the provider owns the
 * membership, ordering, revisions and continuation, and the binding resolves the basics of each
 * association through Catalog and the copies copy-level associations name. The binding keeps the
 * provider records of the window it presented, so the page's editors read the revision, level and
 * intended quantity under the entry's own key instead of composing the read itself; a superseded
 * continuation restarts the sequence and a record another operation advanced while the page read it
 * fails the read as retryable instead of presenting the older state.
 */

import type { Catalog, CardRecord, PrintingRecord } from '../../../catalog/index.js';
import type {
  Association,
  AssociationListResult,
  CopyReadResult,
  PhysicalCopy,
} from '../../../usercards/index.js';
// The provider publishes its constraints through the browser-safe entry point; the backend barrel
// carries the Node-only contracts of the same component.
import type { UserCardsConstraints } from '../../../usercards/browser.js';

import { CARD_LIST_LIMITS } from '../limits.js';
import type {
  CardListEntry,
  CardListEntryOwnership,
  CardListFragmentReader,
  CardListSource,
  CardListSourceRequest,
  CardListTarget,
} from '../contract.js';
import {
  cardListEntryKey,
  observeSearchProgress,
  type CardListSearchRead,
  isInvalidatedContinuation,
  type CardListCountsAccess,
} from './search.js';
import { resolveCards, resolvePrintings } from './catalog.js';

/** The UserCards reads one tag's association binding consumes. */
export interface CardListTagAssociationsRead {
  readonly constraints: UserCardsConstraints;
  associations(
    tagId: string,
    options?: { readonly pageSize?: number; readonly continuation?: string },
    signal?: AbortSignal,
  ): Promise<AssociationListResult>;
  readCopies(copyIds: readonly string[], signal?: AbortSignal): Promise<CopyReadResult>;
}

/**
 * One tag's association list: its source, the provider records the presented window produced and
 * the ownership fragment its entries read.
 */
export interface CardListTagAssociations {
  /** The list source of the tag's associations; the list context is the tag identity. */
  readonly source: CardListSource<string>;
  /** The record of one presented association key, or null when the window no longer holds it. */
  record(key: string): Association | null;
  /** Key of every association the presented window still holds. */
  keys(): readonly string[];
  /**
   * Ownership fragment of the associations: their typed targets, read through the supplied private
   * counts access with the presented tag's intended quantity.
   */
  readonly ownership: CardListFragmentReader<CardListEntryOwnership>;
  /**
   * Takes one association state the page's own operation established: a newer revision replaces
   * the record the editors review, and an older one never regresses the presented state.
   */
  adopt(association: Association): void;
}

/**
 * Builds one tag's association binding over the account's private reads and Catalog. The binding
 * owns the records and the presented window its reads produced.
 */
export function tagAssociationsBinding(options: {
  readonly tagId: string;
  readonly read: CardListTagAssociationsRead;
  readonly catalog: Catalog;
  readonly counts: CardListCountsAccess;
  readonly search?: CardListSearchRead;
}): CardListTagAssociations {
  const tagId = options?.tagId;
  if (typeof tagId !== 'string' || tagId.length === 0) {
    throw new TypeError('An association list presents one tag identity.');
  }
  const read = options?.read;
  if (typeof read?.associations !== 'function' || typeof read?.readCopies !== 'function') {
    throw new TypeError('The associations are read through the UserCards contract.');
  }
  const batchBound = read.constraints?.batch?.references;
  if (typeof batchBound !== 'number' || !Number.isSafeInteger(batchBound) || batchBound < 1) {
    throw new TypeError('The association binding reads copies within the provider batch bound.');
  }
  const catalog = options?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('The associations resolve their basics through Catalog.');
  }
  const counts = options?.counts;
  if (typeof counts?.ofBatch !== 'function') {
    throw new TypeError('The associations read their private counts through Search.');
  }
  const records = new Map<string, Association>();
  // Proof established before the next authoritative read; it covers derived counts only.
  let incorporated: ReadonlySet<string> = new Set();
  /** Keys of the window the list presents, bounded like the list's own working set. */
  const presented: string[] = [];

  return {
    source: {
      ...(options.search === undefined
        ? {}
        : {
            async observe(request) {
              const state = await observeSearchProgress(
                options.search!,
                request.positions,
                request.signal,
              );
              request.signal.throwIfAborted();
              if (state === 'incorporated') incorporated = new Set(request.positions);
              return state;
            },
          }),
      // A committed change of the account's associations, tags or copies may change this sequence,
      // so the list reacquires it through this same read.
      affects: () => true,
      async load(request: CardListSourceRequest<string>) {
        // Never gate authoritative membership on Search availability. A read begun after the
        // observation established its requirements also refreshes the derived fragments.
        const current = request.required.positions.every((position) => incorporated.has(position));
        let page: AssociationListResult;
        try {
          page = await read.associations(
            tagId,
            {
              pageSize: request.pageSize,
              ...(request.continuation === null ? {} : { continuation: request.continuation }),
            },
            request.signal,
          );
        } catch (cause) {
          if (
            !request.signal.aborted &&
            request.continuation !== null &&
            isInvalidatedContinuation(cause)
          ) {
            // The account's private revision the continuation was read at changed: the list
            // restarts the sequence from its first page instead of repeating the unusable cursor.
            return { status: 'invalidated' };
          }
          throw cause;
        }
        request.signal.throwIfAborted();
        const observed = page.associations.map((association) => {
          const current = records.get(associationKey(association));
          return current !== undefined && current.revision > association.revision
            ? current
            : association;
        });
        const entries = await associationEntries(
          observed,
          read,
          catalog,
          batchBound,
          request.signal,
        );
        request.signal.throwIfAborted();
        if (
          observed.some(
            (association) =>
              (records.get(associationKey(association))?.revision ?? 0) > association.revision,
          )
        ) {
          throw new Error('An association changed while loading. Retry to read its current state.');
        }
        for (const association of observed) {
          records.set(associationKey(association), association);
        }
        if (request.continuation === null) {
          presented.length = 0;
        }
        presented.push(...entries.map((entry) => entry.key));
        if (presented.length > CARD_LIST_LIMITS.window) {
          presented.splice(0, presented.length - CARD_LIST_LIMITS.window);
        }
        const window = new Set(presented);
        for (const key of [...records.keys()]) {
          if (!window.has(key)) {
            records.delete(key);
          }
        }
        if (request.continuation === null) counts.invalidate?.();
        // The provider's own read is authoritative for the associations it returns.
        return { status: 'page', entries, continuation: page.continuation, current };
      },
    },
    record(key) {
      return records.get(key) ?? null;
    },
    keys() {
      return [...records.keys()];
    },
    ownership: entryOwnershipOfAssociations(counts, () => tagId, records),
    adopt(association) {
      const key = associationKey(association);
      if ((records.get(key)?.revision ?? 0) <= association.revision) {
        records.set(key, association);
        counts.invalidate?.();
      }
    },
  };
}

/**
 * Ownership fragment of an association list: the entry's typed target comes from the association
 * record the presented window holds, and the intended quantity from the presented tag.
 */
function entryOwnershipOfAssociations(
  counts: CardListCountsAccess,
  tagId: () => string | null,
  records: ReadonlyMap<string, Association>,
): CardListFragmentReader<CardListEntryOwnership> {
  return {
    ...(counts.subscribe === undefined ? {} : { subscribe: counts.subscribe }),
    async read(request) {
      const references = new Map<string, CardListTarget>();
      for (const key of request.keys) {
        const association = records.get(key);
        if (association !== undefined) {
          references.set(key, referenceOfAssociation(association));
        }
      }
      const read = await counts.ofBatch([...references.values()], tagId(), request.signal);
      return request.keys.map((key) => {
        const target = references.get(key) ?? null;
        const count = target === null ? undefined : read.get(cardListEntryKey(target));
        return count === undefined
          ? { key, status: 'absent' as const, values: null }
          : {
              key,
              status: 'ready' as const,
              values: {
                owned: count.owned,
                locations: count.locations,
                intended: count.intended,
              },
            };
      });
    },
  };
}

/** One association as the list protocol presents it: its typed target and resolved basics. */
export function associationListEntry(
  key: string,
  association: Association,
  copies: ReadonlyMap<string, PhysicalCopy>,
  printings: ReadonlyMap<string, PrintingRecord>,
  cards: ReadonlyMap<string, CardRecord>,
): CardListEntry {
  const target = referenceOfAssociation(association);
  const copy =
    association.targetLevel === 'copy' ? (copies.get(association.targetId) ?? null) : null;
  const printing =
    association.targetLevel === 'printing'
      ? (printings.get(association.targetId) ?? null)
      : copy === null
        ? null
        : (printings.get(copy.printingId) ?? null);
  const cardId = association.targetLevel === 'card' ? association.targetId : printing?.cardId;
  const card = cardId === undefined ? null : (cards.get(cardId) ?? null);
  const resolved = card !== null && (association.targetLevel === 'card' || printing !== null);
  return {
    key,
    target,
    basic: resolved
      ? {
          card: { cardId: card.cardId, name: card.name, matchedName: null },
          printing:
            printing === null
              ? null
              : {
                  printingId: printing.printingId,
                  edition: printing.edition,
                  collectorNumber: printing.collectorNumber,
                  language: printing.language,
                },
        }
      : null,
    quantity: null,
  };
}

/** The presented target of one association. */
export function referenceOfAssociation(association: Association): CardListTarget {
  switch (association.targetLevel) {
    case 'card':
      return { kind: 'card', cardId: association.targetId };
    case 'printing':
      return { kind: 'printing', printingId: association.targetId };
    case 'copy':
      return { kind: 'copy', copyId: association.targetId };
  }
}

/** Stable key of one association entry; the row's editor looks the record up under it. */
export function associationKey(association: Association): string {
  return `association:${association.associationId}`;
}

/** Resolve basic entries without publishing state or waiting for optional counts. */
async function associationEntries(
  associations: readonly Association[],
  read: CardListTagAssociationsRead,
  catalog: Catalog,
  batchBound: number,
  signal: AbortSignal,
): Promise<readonly CardListEntry[]> {
  const copies = await readAssociationCopies(associations, read, batchBound, signal);
  const printingIds = new Set<string>();
  for (const association of associations) {
    if (association.targetLevel === 'printing') {
      printingIds.add(association.targetId);
    }
    const copy = copies.get(association.targetId);
    if (association.targetLevel === 'copy' && copy !== undefined) {
      printingIds.add(copy.printingId);
    }
  }
  const printings = await resolvePrintings(catalog, [...printingIds]);
  signal.throwIfAborted();
  const cardIds = new Set<string>();
  for (const association of associations) {
    if (association.targetLevel === 'card') {
      cardIds.add(association.targetId);
    }
  }
  for (const printing of printings.values()) {
    cardIds.add(printing.cardId);
  }
  const cards = await resolveCards(catalog, [...cardIds]);
  return associations.map((association) =>
    associationListEntry(associationKey(association), association, copies, printings, cards),
  );
}

/** Copies the copy-targeted associations name, read in the bounded batches a private read accepts. */
async function readAssociationCopies(
  associations: readonly Association[],
  read: CardListTagAssociationsRead,
  batchBound: number,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PhysicalCopy>> {
  const ids = [
    ...new Set(
      associations
        .filter((association) => association.targetLevel === 'copy')
        .map((association) => association.targetId),
    ),
  ];
  const copies = new Map<string, PhysicalCopy>();
  for (let index = 0; index < ids.length; index += batchBound) {
    const batch = ids.slice(index, index + batchBound);
    const bulk = await read.readCopies(batch, signal);
    for (const copy of bulk.copies.values()) {
      copies.set(copy.copyId, copy);
    }
  }
  return copies;
}
