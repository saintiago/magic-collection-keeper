import { isInvalidatedContinuation } from './read-failure.js';
export { isInvalidatedContinuation, readFailureCode } from './read-failure.js';
/** Direct owner-query bindings of CardList (docs/card-list.md#required-interfaces-and-source-bindings). */

import type {
  CatalogEntry,
  CatalogQueryInput,
  CatalogService,
  Finish,
} from '../../../catalog/index.js';
import type {
  ReadUserCardsFragmentsInput,
  UserCardsFragmentsResult,
  UserCardsQueryInput,
  UserCardsQueryPage,
  UserCardsReference,
  CopyReadResult,
} from '../../../usercards/index.js';

import { resolveCards, resolvePrintings } from './catalog.js';

import type {
  CardListEntry,
  CardListEntryOwnership,
  CardListFragmentReader,
  CardListSource,
  CardListTarget,
} from '../contract.js';

export type CardListResultLevel = 'card' | 'printing' | 'copy';

export interface CardListCatalogQuery {
  readonly text: string;
  readonly level: 'card' | 'printing';
  readonly owned: boolean;
  readonly finish: Finish | null;
}

export interface CardListCollectionQuery {
  readonly cardId?: string;
  readonly text: string;
  readonly level: CardListResultLevel;
}

export interface CardListPickerQuery {
  readonly text: string;
  readonly level: CardListResultLevel;
}

export interface CardListUserCardsRead {
  query(input: UserCardsQueryInput, signal?: AbortSignal): Promise<UserCardsQueryPage>;
  readFragments(
    input: ReadUserCardsFragmentsInput,
    signal?: AbortSignal,
  ): Promise<UserCardsFragmentsResult>;
  readCopies(copyIds: readonly string[], signal?: AbortSignal): Promise<CopyReadResult>;
}

export function catalogQueryRequest(
  query: CardListCatalogQuery,
  pageSize: number,
  continuation: string | null,
): CatalogQueryInput {
  if (query.owned) {
    throw new TypeError('Public catalog queries do not accept private ownership criteria.');
  }
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text === '' ? {} : { query: text }),
    ...(query.finish === null
      ? {}
      : { criteria: [{ kind: 'finish' as const, finish: query.finish }] }),
    pageSize,
    ...(continuation === null ? {} : { continuation }),
  };
}

export function collectionQueryRequest(
  query: CardListCollectionQuery,
  pageSize: number,
  continuation: string | null,
): UserCardsQueryInput {
  if (query.text.trim() !== '') {
    throw new TypeError('Private lists do not accept public catalog criteria.');
  }
  return {
    scope: { kind: 'collection' },
    ...(query.cardId === undefined
      ? {}
      : {
          criteria: [
            {
              kind: 'identity' as const,
              references: [{ kind: 'card' as const, cardId: query.cardId }],
            },
          ],
        }),
    resultLevel: query.level,
    pageSize,
    ...(continuation === null ? {} : { continuation }),
  };
}

export function catalogQuerySource(catalog: CatalogService): CardListSource<CardListCatalogQuery> {
  return {
    affects: (change) => change.scope === 'catalog',
    async load(request) {
      try {
        const page = await catalog.query(
          catalogQueryRequest(request.context, request.pageSize, request.continuation),
          request.signal,
        );
        return {
          status: 'page',
          entries: page.entries.map(catalogEntryOf),
          continuation: page.continuation,
        };
      } catch (cause) {
        if (request.continuation !== null && isInvalidatedContinuation(cause)) {
          return { status: 'invalidated' };
        }
        throw cause;
      }
    },
  };
}

export function collectionQuerySource(
  userCards: CardListUserCardsRead,
  catalog: CatalogService,
): CardListSource<CardListCollectionQuery> {
  return privateQuerySource(userCards, catalog, collectionQueryRequest);
}

export function pickerQuerySource(
  userCards: CardListUserCardsRead,
  catalog: CatalogService,
): CardListSource<CardListPickerQuery> {
  return {
    async load(request) {
      if (request.context.level !== 'copy') {
        const source = catalogQuerySource(catalog);
        return source.load({
          ...request,
          context: {
            text: request.context.text,
            level: request.context.level,
            owned: false,
            finish: null,
          },
        });
      }
      if (request.context.text.trim() !== '') {
        throw new TypeError('Copy pickers do not accept public catalog criteria.');
      }
      return privatePage(
        userCards,
        catalog,
        {
          scope: { kind: 'collection' },
          resultLevel: 'copy',
          pageSize: request.pageSize,
          ...(request.continuation === null ? {} : { continuation: request.continuation }),
        },
        request.signal,
        request.continuation,
      );
    },
    affects: (change, context) => context.level === 'copy' || change.scope === 'catalog',
  };
}

function privateQuerySource<Context>(
  userCards: CardListUserCardsRead,
  catalog: CatalogService,
  build: (context: Context, pageSize: number, continuation: string | null) => UserCardsQueryInput,
): CardListSource<Context> {
  return {
    load: (request) =>
      privatePage(
        userCards,
        catalog,
        build(request.context, request.pageSize, request.continuation),
        request.signal,
        request.continuation,
      ),
    affects: () => true,
  };
}

async function privatePage(
  userCards: CardListUserCardsRead,
  catalog: CatalogService,
  input: UserCardsQueryInput,
  signal: AbortSignal,
  continuation: string | null,
) {
  try {
    const page = await userCards.query(input, signal);
    const copyIds = page.entries.flatMap((entry) =>
      entry.target.kind === 'copy' ? [entry.target.copyId] : [],
    );
    const copies =
      copyIds.length === 0 ? { copies: new Map() } : await userCards.readCopies(copyIds, signal);
    const printings = await resolvePrintings(catalog, [
      ...page.entries.flatMap((entry) =>
        entry.target.kind === 'printing' ? [entry.target.printingId] : [],
      ),
      ...[...copies.copies.values()].map((copy) => copy.printingId),
    ]);
    const cards = await resolveCards(catalog, [
      ...page.entries.flatMap((entry) =>
        entry.target.kind === 'card' ? [entry.target.cardId] : [],
      ),
      ...[...printings.values()].map((printing) => printing.cardId),
    ]);
    const resolution = { cards, printings };
    return {
      status: 'page' as const,
      entries: page.entries.map((entry) => {
        const target = entry.target;
        const copy = target.kind === 'copy' ? copies.copies.get(target.copyId) : undefined;
        const printing =
          target.kind === 'printing'
            ? resolution.printings.get(target.printingId)
            : copy === undefined
              ? undefined
              : resolution.printings.get(copy.printingId);
        const card =
          target.kind === 'card'
            ? resolution.cards.get(target.cardId)
            : printing === undefined
              ? undefined
              : resolution.cards.get(printing.cardId);
        return {
          key: entry.entryKey,
          target,
          basic:
            card === undefined
              ? null
              : {
                  card: { cardId: card.cardId, name: card.name, matchedName: null },
                  printing:
                    printing === undefined
                      ? null
                      : {
                          printingId: printing.printingId,
                          edition: printing.edition,
                          collectorNumber: printing.collectorNumber,
                          language: printing.language,
                        },
                },
          quantity: {
            copies: entry.ownedCopyCount,
            intended: entry.intendedQuantity,
          },
        } satisfies CardListEntry;
      }),
      continuation: page.continuation,
    };
  } catch (cause) {
    if (continuation !== null && isInvalidatedContinuation(cause)) {
      return { status: 'invalidated' as const };
    }
    throw cause;
  }
}

export function catalogEntryOf(entry: CatalogEntry): CardListEntry {
  const printing = entry.printing;
  return {
    key: cardListEntryKey(entry.target),
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
    quantity: null,
  };
}

export function cardListEntryKey(target: CardListTarget): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `printing:${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
    case 'pending':
      return `pending:${target.entryId}`;
  }
}

export function cardListTargetOfKey(key: string): CardListTarget | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
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

export interface CardListEntryCounts {
  readonly owned: number;
  readonly locations: number;
  readonly intended: number | null;
}

export interface CardListCountsAccess {
  invalidate?(): void;
  subscribe?(listener: () => void): () => void;
  ofBatch(
    targets: readonly CardListTarget[],
    tagId: string | null,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, CardListEntryCounts>>;
}

export function userCardsCounts(userCards: CardListUserCardsRead): CardListCountsAccess {
  const listeners = new Set<() => void>();
  return {
    invalidate() {
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async ofBatch(targets, tagId, signal) {
      const references = targets.map(referenceOfTarget);
      if (references.length === 0) return new Map();
      const result = await userCards.readFragments(
        { references, ...(tagId === null ? {} : { tagId }) },
        signal,
      );
      return new Map(
        [...result.fragments].map(([key, fragment]) => [
          key,
          {
            owned: fragment.ownedCopyCount,
            locations: fragment.physicalLocationCount,
            intended: fragment.intendedQuantity,
          },
        ]),
      );
    },
  };
}

function referenceOfTarget(target: CardListTarget): UserCardsReference {
  if (target.kind === 'pending') {
    throw new TypeError('A pending import entry carries no private fragment reference.');
  }
  return target;
}

export function entryOwnershipReader(
  counts: CardListCountsAccess,
  referenceOfKey: (key: string) => CardListTarget | null = cardListTargetOfKey,
  tagId: () => string | null = () => null,
): CardListFragmentReader<CardListEntryOwnership> {
  return {
    ...(counts.subscribe === undefined ? {} : { subscribe: counts.subscribe }),
    async read(request) {
      const references = new Map<string, CardListTarget>();
      for (const key of request.keys) {
        const target = referenceOfKey(key);
        if (target !== null) references.set(key, target);
      }
      const read = await counts.ofBatch([...references.values()], tagId(), request.signal);
      return request.keys.map((key) => {
        const target = references.get(key);
        const count = target === undefined ? undefined : read.get(cardListEntryKey(target));
        return count === undefined
          ? { key, status: 'absent' as const, values: null }
          : { key, status: 'ready' as const, values: count };
      });
    },
  };
}
