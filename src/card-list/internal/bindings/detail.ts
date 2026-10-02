/**
 * Detail-target binding of CardList (docs/card-list.md#interface,
 * docs/ui/pages.md#page-map, docs/ui/card-views.md#interface).
 *
 * One typed detail target — a card, one of its printings or one physical copy — becomes a
 * one-entry list whose entry carries the published presentation of the level and, at the copy
 * level, the account's private copy record the editor presents. The reads belong to this binding:
 * the Catalog resolution of the level and the account-scoped UserCards read of a copy. A page
 * describes the target and composes the presentation it receives; it never reads card or copy
 * content itself.
 */

import type { CardRecord, Catalog, PrintingRecord } from '../../../catalog/index.js';
import type { PhysicalCopy } from '../../../usercards/index.js';

import type {
  CardListEntry,
  CardListEntryDetail,
  CardListSource,
  CardListSourceRequest,
} from '../contract.js';

/** One typed detail target as a page describes it: the route context of the level it presents. */
export type CardListDetailTarget =
  | { readonly kind: 'card'; readonly cardId: string }
  | {
      readonly kind: 'printing';
      readonly printingId: string;
      /** Card the route names, used when the printing itself is not published. */
      readonly cardId: string | null;
    }
  | {
      readonly kind: 'copy';
      readonly copyId: string;
      /** Card the route names, used when the printing itself is not published. */
      readonly cardId: string | null;
    };

/** The private copy read of one account, as the binding consumes it. */
export interface CardListDetailCopyReader {
  readCopies(
    copyIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ readonly copies: ReadonlyMap<string, PhysicalCopy> }>;
}

export interface CardListDetailBindingOptions {
  readonly catalog: Catalog;
  /** Verified account whose copies a copy-level target reads. */
  readonly accountId: string;
  /** Copy reads of that account; supplied by the account's UserCards operations. */
  readonly copies: CardListDetailCopyReader;
}

/**
 * The published content of one typed detail target as a one-entry list source. A target the
 * provider does not publish yields one entry whose detail reports the explicit absence, so a
 * presentation distinguishes "not published" from a failed read; the copy level is authoritative
 * for its own record, so the read reports the copy's current attributes and its absence.
 */
export function detailTargetSource(
  options: CardListDetailBindingOptions,
  target: CardListDetailTarget,
): CardListSource<CardListDetailTarget> {
  if (typeof options?.catalog?.resolve !== 'function') {
    throw new TypeError('A detail target is resolved through the Catalog contract.');
  }
  if (typeof options?.copies?.readCopies !== 'function') {
    throw new TypeError('A copy-level detail target is read through the UserCards contract.');
  }
  return {
    // The Catalog publishes printings and cards, and the account's copies carry revisions: both
    // change the level this entry presents.
    affects: (change) => target.kind === 'copy' || change.scope === 'catalog',
    async load(request: CardListSourceRequest<CardListDetailTarget>) {
      if (request.continuation !== null) {
        // The level is one entry; a continuation is a list the source never produced.
        return { status: 'invalidated' };
      }
      return {
        status: 'page',
        entries: [await readDetailEntry(options, target, request.signal)],
        continuation: null,
        // The level reads the providers directly, so the entry describes the state it observed.
      };
    },
  };
}

/** The one entry of the level: its key, typed target, basic information and detail facts. */
async function readDetailEntry(
  options: CardListDetailBindingOptions,
  target: CardListDetailTarget,
  signal: AbortSignal,
): Promise<CardListEntry> {
  switch (target.kind) {
    case 'card': {
      const card = await resolveCard(options.catalog, target.cardId);
      return card === null
        ? absentEntry(`card:${target.cardId}`, { kind: 'card', cardId: target.cardId }, 'card')
        : {
            key: `card:${card.cardId}`,
            target: { kind: 'card', cardId: card.cardId },
            basic: { card: cardBasic(card), printing: null },
            quantity: null,
            detail: { absent: null, copy: null },
          };
    }
    case 'printing': {
      const printing = await resolvePrinting(options.catalog, target.printingId);
      if (printing === null) {
        return absentEntry(
          `printing:${target.printingId}`,
          { kind: 'printing', printingId: target.printingId },
          'printing',
        );
      }
      const card = await resolveCard(options.catalog, printing.cardId);
      if (card === null) {
        return absentEntry(
          `printing:${printing.printingId}`,
          { kind: 'printing', printingId: printing.printingId },
          'printing-card',
        );
      }
      return {
        key: `printing:${printing.printingId}`,
        target: { kind: 'printing', printingId: printing.printingId },
        basic: { card: cardBasic(card), printing: printingBasic(printing) },
        quantity: null,
        detail: { absent: null, copy: null },
      };
    }
    case 'copy': {
      const copy = (await options.copies.readCopies([target.copyId], signal)).copies.get(
        target.copyId,
      );
      if (copy === undefined) {
        return absentEntry(
          `copy:${target.copyId}`,
          { kind: 'copy', copyId: target.copyId },
          'copy',
        );
      }
      // The copy names the printing it now carries; the route's card is the fallback for a
      // printing the catalog does not publish (docs/ui/pages.md#page-map).
      const printing = await resolvePrinting(options.catalog, copy.printingId);
      const cardId = printing?.cardId ?? target.cardId;
      const card = cardId === null ? null : await resolveCard(options.catalog, cardId);
      return {
        key: `copy:${copy.copyId}`,
        target: { kind: 'copy', copyId: copy.copyId },
        basic:
          card === null
            ? null
            : {
                card: cardBasic(card),
                printing: printing === null ? null : printingBasic(printing),
              },
        quantity: null,
        detail: { absent: null, copy },
      };
    }
  }
}

/** One entry whose level the provider does not publish, with the absence it recorded. */
function absentEntry(
  key: string,
  target: CardListEntry['target'],
  absent: CardListEntryDetail['absent'],
): CardListEntry {
  return {
    key,
    target,
    basic: null,
    quantity: null,
    detail: { absent, copy: null },
  };
}

/** Published basic information of one card, including the detail presentation facts. */
function cardBasic(card: CardRecord): NonNullable<CardListEntry['basic']>['card'] {
  return {
    cardId: card.cardId,
    name: card.name,
    matchedName: null,
    typeLine: card.typeLine,
    rulesText: card.rulesText,
  };
}

/** Published basic information of one printing, including the finishes it offers. */
function printingBasic(printing: PrintingRecord): NonNullable<CardListEntry['basic']>['printing'] {
  return {
    printingId: printing.printingId,
    edition: printing.edition,
    collectorNumber: printing.collectorNumber,
    language: printing.language,
    finishes: printing.finishes,
  };
}

/** One card the catalog publishes, or null when the published revision does not carry it. */
async function resolveCard(catalog: Catalog, cardId: string): Promise<CardRecord | null> {
  const resolution = await catalog.resolve([{ kind: 'card', cardId }]);
  return resolution.cards.get(cardId) ?? null;
}

/** One printing the catalog publishes, or null when the published revision does not carry it. */
async function resolvePrinting(
  catalog: Catalog,
  printingId: string,
): Promise<PrintingRecord | null> {
  const resolution = await catalog.resolve([{ kind: 'printing', printingId }]);
  return resolution.printings.get(printingId) ?? null;
}
