import type { CardId, LanguageCode, PrintingId } from '../../catalog/index.js';
import type { CopyId } from '../../usercards/index.js';

import type { SearchRevisions } from './model.js';

/**
 * Result contract of the Search component (docs/search.md#request-and-result).
 *
 * A page is only produced by a successful evaluation: an unavailable evaluation, invalid or
 * unsupported criteria, unauthorized access and a stale continuation are failures, never an empty
 * page. Entries carry a stable key derived from their typed target, basic card information and the
 * quantity context the query evaluated; counts are exact when supplied and null when unavailable.
 */

/** Typed reference of one entry, at the query's result level. */
export type SearchEntryTarget =
  | { readonly kind: 'card'; readonly cardId: CardId }
  | { readonly kind: 'printing'; readonly printingId: PrintingId }
  | { readonly kind: 'copy'; readonly copyId: CopyId };

/**
 * Stable identity of one entry. It is derived from the target alone, so the same entry keeps its
 * key across pages, refinement and enrichment.
 */
export function searchEntryKey(target: SearchEntryTarget): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `printing:${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
  }
}

/** Basic card information of one resolved entry. */
export interface SearchEntryCard {
  readonly cardId: CardId;
  /** Canonical name of the playable identity. */
  readonly name: string;
  /**
   * Translated or face name that matched the query, when it differs from the canonical name;
   * otherwise null (docs/search.md#evaluation-and-grouping).
   */
  readonly matchedName: string | null;
}

/** Basic printing information of a printing- or copy-level entry. */
export interface SearchEntryPrinting {
  readonly printingId: PrintingId;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: LanguageCode;
}

/**
 * Quantity context of one entry. Physical copy counts and intended quantities stay distinct
 * (docs/architecture.md#tags-and-associations); an unavailable count is null, not zero.
 */
export interface SearchEntryQuantity {
  /** Matching physical copies, exact when supplied; null when the query evaluated none. */
  readonly copies: number | null;
  /** Intended or required quantity of a matching card or printing association; null when none. */
  readonly intended: number | null;
}

export interface SearchEntry {
  /** Stable key of this entry; see searchEntryKey. */
  readonly entryKey: string;
  readonly target: SearchEntryTarget;
  readonly card: SearchEntryCard;
  /** Printing information for a printing or copy entry; null at card level. */
  readonly printing: SearchEntryPrinting | null;
  /** Quantity context this entry carries; null when the query evaluated none. */
  readonly quantity: SearchEntryQuantity | null;
}

export interface SearchPage {
  readonly entries: readonly SearchEntry[];
  /** Exact number of matching entries when supplied; null when the count is unavailable. */
  readonly totalCount: number | null;
  /** Opaque continuation of the next page, or null when this page ends the result. */
  readonly continuation: string | null;
  /** Revisions this page was evaluated against; its continuation is bound to them. */
  readonly revisions: SearchRevisions;
}
