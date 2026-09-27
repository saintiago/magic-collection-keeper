import { z } from 'zod';

import { SearchError } from './errors.js';
import type { SearchSqlRow } from './executor.js';
import {
  SEARCH_LIMITS,
  requiresTrustedContext,
  type SearchQuery,
  type SearchRevisions,
} from './model.js';
import {
  searchCountKey,
  type SearchCount,
  type SearchCountReference,
  type SearchCountResult,
} from './results.js';

/**
 * Reads the rows of one page statement (docs/search.md#request-and-result). The statement returns
 * one row per entry plus one row carrying the revisions and the exact count of the whole result.
 * Anything outside the declared shape is an unavailable evaluation: it is never reported as an
 * empty page or as zero entries.
 */

const identifier = z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength);

const entryRowSchema = z.object({
  row_kind: z.literal('entry'),
  row_position: z.number().int().min(1),
  entry_id: identifier,
  card_id: identifier,
  card_name: z.string().min(1).max(300),
  matched_name: z.string().min(1).max(300).nullable(),
  printing_id: identifier.nullable(),
  edition: z.string().min(1).max(SEARCH_LIMITS.maxEditionLength).nullable(),
  collector_number: z.string().min(1).max(32).nullable(),
  language: z.string().min(1).max(20).nullable(),
  copies: z.number().int().min(0).nullable(),
  intended: z.number().int().min(0).nullable(),
});

const revisionRowSchema = z.object({
  row_kind: z.literal('revision'),
  row_position: z.literal(0),
  catalog_revision: identifier,
  private_revision: identifier.nullable(),
  total_count: z.number().int().min(0),
});

const countRowSchema = z.object({
  row_kind: z.literal('count'),
  ref_kind: z.enum(['card', 'printing', 'copy']),
  ref_id: identifier,
  owned: z.number().int().min(0),
  locations: z.number().int().min(0),
  intended: z.number().int().min(0).nullable(),
});

const countRevisionRowSchema = z.object({
  row_kind: z.literal('revision'),
  private_revision: identifier,
});

/** Basic information of the printing one entry represents; null at card level. */
export interface SearchEntryPrintingRow {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
}

/** One evaluated entry, before it is typed against the query's result level. */
export interface SearchEntryRow {
  readonly entryId: string;
  readonly cardId: string;
  readonly cardName: string;
  readonly matchedName: string | null;
  readonly printing: SearchEntryPrintingRow | null;
  /** Matching physical copies of this entry; null when the query read no private data. */
  readonly copies: number | null;
  /** Intended or required quantity of the positively named tags; null when none matched. */
  readonly intended: number | null;
}

export interface SearchRowsPage {
  readonly revisions: SearchRevisions;
  readonly totalCount: number;
  readonly entries: readonly SearchEntryRow[];
}

export function readSearchRows(rows: readonly SearchSqlRow[], query: SearchQuery): SearchRowsPage {
  let revisions: SearchRevisions | null = null;
  let totalCount: number | null = null;
  const entries: SearchEntryRow[] = [];
  for (const row of rows) {
    if (row.row_kind === 'entry') {
      const parsed = entryRowSchema.safeParse(row);
      if (!parsed.success) {
        throw unreadable();
      }
      entries.push(entryRow(parsed.data, query));
      continue;
    }
    const parsed = revisionRowSchema.safeParse(row);
    if (!parsed.success) {
      throw unreadable();
    }
    revisions = {
      catalogRevision: parsed.data.catalog_revision,
      privateRevision: parsed.data.private_revision,
    };
    totalCount = parsed.data.total_count;
  }
  if (revisions === null || totalCount === null) {
    throw new SearchError('unavailable', 'The catalog has no published revision to read.');
  }
  if (requiresTrustedContext(query) && revisions.privateRevision === null) {
    throw new SearchError(
      'unavailable',
      'The bound account’s private-data revision could not be read.',
    );
  }
  return { revisions, totalCount, entries };
}

function entryRow(row: z.infer<typeof entryRowSchema>, query: SearchQuery): SearchEntryRow {
  const printing = printingRow(row);
  if ((query.resultLevel === 'card') !== (printing === null)) {
    throw unreadable();
  }
  if (query.resultLevel === 'printing' && row.entry_id !== printing?.printingId) {
    throw unreadable();
  }
  return {
    entryId: row.entry_id,
    cardId: row.card_id,
    cardName: row.card_name,
    matchedName: row.matched_name,
    printing,
    copies: row.copies,
    intended: row.intended,
  };
}

function printingRow(row: z.infer<typeof entryRowSchema>): SearchEntryPrintingRow | null {
  if (
    row.printing_id === null &&
    row.edition === null &&
    row.collector_number === null &&
    row.language === null
  ) {
    return null;
  }
  if (
    row.printing_id === null ||
    row.edition === null ||
    row.collector_number === null ||
    row.language === null
  ) {
    throw unreadable();
  }
  return {
    printingId: row.printing_id,
    edition: row.edition,
    collectorNumber: row.collector_number,
    language: row.language,
  };
}

function unreadable(): SearchError {
  return new SearchError(
    'unavailable',
    'Search returned a result that does not match its read contract.',
  );
}

/**
 * Reads one count statement: every requested reference is answered exactly, and a reference the
 * statement did not count is an unavailable read instead of an inferred zero. The private
 * revision the read observed accompanies the counts.
 */
export function readSearchCountRows(
  rows: readonly SearchSqlRow[],
  references: readonly SearchCountReference[],
): SearchCountResult {
  let privateRevision: string | null = null;
  const counts = new Map<string, SearchCount>();
  for (const row of rows) {
    if (row.row_kind === 'count') {
      const parsed = countRowSchema.safeParse(row);
      if (!parsed.success) {
        throw unreadable();
      }
      const reference = countReference(parsed.data.ref_kind, parsed.data.ref_id);
      counts.set(searchCountKey(reference), {
        owned: parsed.data.owned,
        locations: parsed.data.locations,
        intended: parsed.data.intended,
      });
      continue;
    }
    const parsed = countRevisionRowSchema.safeParse(row);
    if (!parsed.success) {
      throw unreadable();
    }
    privateRevision = parsed.data.private_revision;
  }
  if (privateRevision === null) {
    throw new SearchError(
      'unavailable',
      'The bound account’s private-data revision could not be read.',
    );
  }
  for (const reference of references) {
    if (!counts.has(searchCountKey(reference))) {
      throw unreadable();
    }
  }
  return { privateRevision, counts };
}

function countReference(
  kind: 'card' | 'printing' | 'copy',
  referenceId: string,
): SearchCountReference {
  switch (kind) {
    case 'card':
      return { kind, cardId: referenceId };
    case 'printing':
      return { kind, printingId: referenceId };
    case 'copy':
      return { kind, copyId: referenceId };
  }
}
