/**
 * Recognition compatibility lookups (docs/recognition.md#interface,
 * docs/application.md#interface).
 *
 * The preserved browser engines keep their own transport envelopes: a candidate is hydrated
 * through `GET /api/card?printing=<id>&oracle=<card>`, and a translated printing is resolved
 * through the narrow Scryfall subset
 * `GET /api/search?q=oracleid:<card> set:<set> cn:<number> lang:<language>`. Catalog owns the
 * records and the published revision; this boundary answers exactly those two lookups from the
 * Catalog contract, so the engines stay byte-identical and an expression outside the subset is
 * rejected explicitly instead of being reinterpreted.
 */

import {
  CATALOG_LIMITS,
  type CardRecord,
  type Catalog,
  type PrintingRecord,
} from '../../catalog/index.js';

import { ApplicationError } from './errors.js';

/** The exact printing a preserved engine hydrated a candidate into. */
export interface PreservedCardQuery {
  readonly printingId: string;
  /** Expected playable identity, or null when the caller named only the printing. */
  readonly cardId: string | null;
}

/** The translated printing lookup: one card, narrowed by any of set, collector number and language. */
export interface PreservedSearchQuery {
  readonly cardId: string;
  readonly edition: string | null;
  readonly collectorNumber: string | null;
  readonly language: string | null;
}

/** One card as the preserved resolution consumes it. */
export interface PreservedPrintingRecord {
  readonly id: string;
  readonly oracle_id: string;
  readonly name: string;
  readonly set: string;
  readonly collector_number: string;
  readonly lang: string;
  readonly finishes: readonly string[];
}

const preservedSearchKeys = ['oracleid', 'set', 'cn', 'lang'] as const;

/** Pages a preserved lookup scans before it reports no matching printing. */
const maxPreservedLookupPages = 50;

/** Reads the `GET /api/card` query; a printing identity is required. */
export function readPreservedCardQuery(
  query: Readonly<Record<string, string | undefined>>,
): PreservedCardQuery {
  const printingId = readReference(query.printing, 'printing');
  if (printingId === null) {
    throw new ApplicationError(
      'invalid-request',
      'A preserved card lookup requires the printing identity.',
    );
  }
  return { printingId, cardId: readReference(query.oracle, 'oracle') };
}

/** Reads the `GET /api/search` query's supported subset, or rejects the expression. */
export function readPreservedSearchQuery(
  query: Readonly<Record<string, string | undefined>>,
): PreservedSearchQuery {
  const expression = query.q?.trim();
  if (expression === undefined || expression.length === 0) {
    throw new ApplicationError(
      'unsupported-query',
      'The preserved search lookup requires a q expression.',
    );
  }
  const terms = new Map<string, string>();
  for (const term of expression.split(/\s+/u)) {
    const separator = term.indexOf(':');
    const key = separator > 0 ? term.slice(0, separator).toLowerCase() : '';
    const value = separator > 0 ? term.slice(separator + 1) : '';
    if (
      !(preservedSearchKeys as readonly string[]).includes(key) ||
      value.length === 0 ||
      value.length > CATALOG_LIMITS.maxIdentifierLength
    ) {
      throw new ApplicationError(
        'unsupported-query',
        `The preserved search lookup supports only ${preservedSearchKeys.join(', ')} terms.`,
      );
    }
    terms.set(key, value);
  }
  const cardId = readReference(terms.get('oracleid'), 'oracleid');
  if (cardId === null) {
    throw new ApplicationError(
      'unsupported-query',
      'The preserved search lookup requires the oracleid term.',
    );
  }
  return {
    cardId,
    edition: readReference(terms.get('set'), 'set'),
    collectorNumber: readReference(terms.get('cn'), 'cn'),
    language: readReference(terms.get('lang'), 'lang'),
  };
}

/** Resolves one exact printing of a candidate, or null when the published revision lacks it. */
export async function resolvePreservedPrinting(
  catalog: Catalog,
  lookup: PreservedCardQuery,
): Promise<PreservedPrintingRecord | null> {
  const references = [
    { kind: 'printing' as const, printingId: lookup.printingId },
    ...(lookup.cardId === null ? [] : [{ kind: 'card' as const, cardId: lookup.cardId }]),
  ];
  const resolution = await catalog.resolve(references);
  const printing = resolution.printings.get(lookup.printingId);
  if (printing === undefined || (lookup.cardId !== null && printing.cardId !== lookup.cardId)) {
    return null;
  }
  const card =
    resolution.cards.get(printing.cardId) ?? (await resolveCard(catalog, printing.cardId));
  return card === null ? null : preservedPrinting(card, printing);
}

/** Finds the printing one card publishes under a set, collector number and language. */
export async function findPreservedPrinting(
  catalog: Catalog,
  lookup: PreservedSearchQuery,
): Promise<PreservedPrintingRecord | null> {
  let continuation: string | null = null;
  for (let page = 0; page < maxPreservedLookupPages; page += 1) {
    const listed = await catalog.listCardPrintings(lookup.cardId, {
      pageSize: CATALOG_LIMITS.maxPrintingPageSize,
      ...(continuation === null ? {} : { continuation }),
    });
    const printing = listed.printings.find((candidate) => matchesLookup(candidate, lookup));
    if (printing !== undefined) {
      const resolution = await catalog.resolve([{ kind: 'card', cardId: lookup.cardId }]);
      const card = resolution.cards.get(lookup.cardId);
      return card === undefined ? null : preservedPrinting(card, printing);
    }
    if (listed.continuation === null || listed.continuation === continuation) {
      return null;
    }
    continuation = listed.continuation;
  }
  return null;
}

async function resolveCard(catalog: Catalog, cardId: string): Promise<CardRecord | null> {
  const resolution = await catalog.resolve([{ kind: 'card', cardId }]);
  return resolution.cards.get(cardId) ?? null;
}

function matchesLookup(printing: PrintingRecord, lookup: PreservedSearchQuery): boolean {
  if (lookup.edition !== null && printing.edition.toLowerCase() !== lookup.edition.toLowerCase()) {
    return false;
  }
  if (
    lookup.collectorNumber !== null &&
    printing.collectorNumber.toLowerCase() !== lookup.collectorNumber.toLowerCase()
  ) {
    return false;
  }
  return (
    lookup.language === null || printing.language.toLowerCase() === lookup.language.toLowerCase()
  );
}

function preservedPrinting(card: CardRecord, printing: PrintingRecord): PreservedPrintingRecord {
  return {
    id: printing.printingId,
    oracle_id: printing.cardId,
    name: card.name,
    set: printing.edition,
    collector_number: printing.collectorNumber,
    lang: printing.language,
    finishes: printing.finishes,
  };
}

function readReference(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > CATALOG_LIMITS.maxIdentifierLength) {
    throw new ApplicationError(
      'invalid-request',
      `The preserved ${label} reference is not a usable identifier.`,
    );
  }
  return value;
}
