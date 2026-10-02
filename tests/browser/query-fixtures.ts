/** Small presentation fixtures expanded into the provider-owned query contracts. */
import type {
  CatalogEntry,
  CatalogQueryInput,
  CatalogQueryPage,
  CatalogReference,
  CatalogResolution,
  CardRecord,
  PrintingRecord,
} from '../../src/catalog/index.js';
import type {
  UserCardsQueryInput,
  UserCardsQueryPage,
  ReadUserCardsFragmentsInput,
  UserCardsFragmentsResult,
} from '../../src/usercards/index.js';
import type { CardListEntryCounts } from '../../src/card-list/index.js';
export interface QueryEntryFixture {
  readonly entryKey: string;
  readonly target:
    | { readonly kind: 'card'; readonly cardId: string }
    | { readonly kind: 'printing'; readonly printingId: string }
    | { readonly kind: 'copy'; readonly copyId: string };
  readonly card: {
    readonly cardId: string;
    readonly name: string;
    readonly matchedName: string | null;
  };
  readonly printing: {
    readonly printingId: string;
    readonly edition: string;
    readonly collectorNumber: string;
    readonly language: string;
  } | null;
  readonly quantity: { readonly copies: number | null; readonly intended: number | null } | null;
}
export interface QueryPageFixture {
  readonly entries: readonly QueryEntryFixture[];
  readonly totalCount: number;
  readonly continuation: string | null;
}
export type QueryInputFixture = CatalogQueryInput | UserCardsQueryInput;
export type CountsFixture = CardListEntryCounts;
export interface CountsResultFixture {
  readonly privateRevision: string;
  readonly counts: ReadonlyMap<string, CountsFixture>;
}
export const fixtureRevision = {
  revisionId: 'fixture',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};
export function fixtureCard(entry: QueryEntryFixture): CardRecord {
  return {
    ...entry.card,
    names: [],
    rulesText: '',
    typeLine: '',
    colors: [],
    colorIdentity: [],
    manaValue: 0,
  };
}
export function fixturePrinting(entry: QueryEntryFixture): PrintingRecord | null {
  return entry.printing === null
    ? null
    : {
        ...entry.printing,
        cardId: entry.card.cardId,
        finishes: ['nonfoil'],
        physical: true,
        images: { normal: null, small: null, large: null, artCrop: null },
      };
}
export function publicPage(page: QueryPageFixture): CatalogQueryPage {
  return {
    entries: page.entries.map(
      (entry) =>
        ({
          ...entry,
          target: entry.target,
          card: { ...fixtureCard(entry), matchedName: entry.card.matchedName },
          printing: fixturePrinting(entry),
        }) as CatalogEntry,
    ),
    totalCount: page.totalCount,
    continuation: page.continuation,
    revision: fixtureRevision,
  };
}
export function privatePage(page: QueryPageFixture): UserCardsQueryPage {
  return {
    entries: page.entries.map((entry) => ({
      entryKey: entry.entryKey,
      target: entry.target,
      ownedCopyCount: entry.quantity?.copies ?? 0,
      intendedQuantity: entry.quantity?.intended ?? null,
      physicalLocationCount: 0,
      directAssociationCount: 0,
      derivedAssociationCount: 0,
    })),
    totalCount: page.totalCount,
    continuation: page.continuation,
    privateRevision: '1',
  };
}
export function fragmentPage(
  input: ReadUserCardsFragmentsInput,
  result: CountsResultFixture,
): UserCardsFragmentsResult {
  return {
    privateRevision: result.privateRevision,
    missing: [],
    fragments: new Map(
      input.references.flatMap((reference) => {
        const key =
          reference.kind === 'card'
            ? `card:${reference.cardId}`
            : reference.kind === 'printing'
              ? `printing:${reference.printingId}`
              : `copy:${reference.copyId}`;
        const count = result.counts.get(key);
        return count === undefined
          ? []
          : [
              [
                key,
                {
                  reference,
                  ownedCopyCount: count.owned,
                  physicalLocationCount: count.locations,
                  intendedQuantity: count.intended,
                  tagIds: [],
                },
              ],
            ];
      }),
    ),
  };
}
export function fixtureResolution(
  entries: readonly QueryEntryFixture[],
  references: readonly CatalogReference[],
): CatalogResolution {
  const cards = new Map(entries.map((entry) => [entry.card.cardId, fixtureCard(entry)]));
  const printings = new Map(
    entries.flatMap((entry) => {
      const printing = fixturePrinting(entry);
      return printing === null ? [] : [[printing.printingId, printing] as const];
    }),
  );
  return {
    revision: fixtureRevision,
    cards,
    printings,
    missing: references.filter((ref) =>
      ref.kind === 'card' ? !cards.has(ref.cardId) : !printings.has(ref.printingId),
    ),
  };
}
