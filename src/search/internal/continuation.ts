import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { TrustedUserContext } from '../../usercards/index.js';
import { readTrustedAccountId } from './context.js';
import { SearchError } from './errors.js';
import {
  SEARCH_LIMITS,
  canonicalizeSearchFilters,
  requiresTrustedContext,
  searchFilterKey,
  type SearchQuery,
  type SearchRevisions,
} from './model.js';

/**
 * Query, user and revisions one continuation is bound to (docs/search.md#request-and-result).
 * Evaluation resumes only when the normalized criteria and ordering, the account and the indexed
 * state all match; otherwise the continuation is stale and the result must restart.
 */
export interface SearchContinuationBinding {
  readonly query: SearchQuery;
  /** Trusted context the query is evaluated for; null or absent for a public query. */
  readonly context?: TrustedUserContext | null;
  readonly revisions: SearchRevisions;
}

/** One identifier-sized field of a continuation: a revision, a generation or a position. */
const boundRevision = z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength);

const continuationPayloadSchema = z.object({
  version: z.literal(2),
  /** Digest of the normalized criteria, ordering and account; the raw query stays out of the token. */
  fingerprint: z.string().length(64),
  generation: boundRevision,
  catalogRevision: boundRevision,
  catalogPosition: boundRevision,
  privateRevision: boundRevision.nullable(),
  offset: z.number().int().min(0),
});

type SearchContinuationPayload = z.infer<typeof continuationPayloadSchema>;

/** Issues the opaque continuation of the next page of the same query and user. */
export function encodeSearchContinuation(
  binding: SearchContinuationBinding & { readonly offset: number },
): string {
  const accountId = boundAccountId(binding);
  if (!Number.isInteger(binding.offset) || binding.offset < 0) {
    throw new SearchError(
      'invalid-request',
      'A continuation offset must be a non-negative whole number.',
    );
  }
  if (!isBoundRevision(binding.revisions.catalogRevision)) {
    throw new SearchError('invalid-request', 'A continuation needs the catalog revision it read.');
  }
  if (
    !isBoundRevision(binding.revisions.generation) ||
    !isBoundRevision(binding.revisions.catalogPosition)
  ) {
    throw new SearchError(
      'invalid-request',
      'A continuation needs the indexed generation and position it read.',
    );
  }
  if (
    requiresTrustedContext(binding.query) &&
    !isBoundRevision(binding.revisions.privateRevision)
  ) {
    throw new SearchError(
      'invalid-request',
      'A private search continuation needs the private revision it read.',
    );
  }
  const payload: SearchContinuationPayload = {
    version: 2,
    fingerprint: searchQueryFingerprint(binding.query, accountId),
    generation: binding.revisions.generation,
    catalogRevision: binding.revisions.catalogRevision,
    catalogPosition: binding.revisions.catalogPosition,
    privateRevision: binding.revisions.privateRevision,
    offset: binding.offset,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Reads the next-page offset of a continuation bound to this query, user and revisions. An
 * unreadable token is an invalid request; a readable token that belongs to another query, user or
 * revision is stale and requires restarting the result.
 */
export function decodeSearchContinuation(
  token: string,
  binding: SearchContinuationBinding,
): number {
  return verifySearchContinuation(readSearchContinuation(token), binding);
}

/** What one readable continuation promises, before it is checked against a query and revisions. */
export interface SearchContinuationCursor {
  /** Offset of the next page inside the result sequence. */
  readonly offset: number;
  /** Digest of the query, user and ordering the continuation was issued for. */
  readonly fingerprint: string;
  readonly generation: string;
  readonly catalogRevision: string;
  readonly catalogPosition: string;
  readonly privateRevision: string | null;
}

/**
 * Reads the offset and binding of a continuation token. Evaluation reads the cursor before it
 * evaluates the page, because the revisions are part of that page's own snapshot; the cursor is
 * checked against them with `verifySearchContinuation` once they are known.
 */
export function readSearchContinuation(token: string): SearchContinuationCursor {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > SEARCH_LIMITS.maxContinuationLength
  ) {
    throw unreadable();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadable();
  }
  const parsed = continuationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadable();
  }
  return parsed.data;
}

/**
 * Checks one readable cursor against the query, user and revisions the page was read with, and
 * returns its offset. A continuation that belongs to another query, user or revision is stale.
 */
export function verifySearchContinuation(
  cursor: SearchContinuationCursor,
  binding: SearchContinuationBinding,
): number {
  const accountId = boundAccountId(binding);
  if (
    cursor.fingerprint !== searchQueryFingerprint(binding.query, accountId) ||
    cursor.generation !== binding.revisions.generation ||
    cursor.catalogRevision !== binding.revisions.catalogRevision ||
    cursor.catalogPosition !== binding.revisions.catalogPosition ||
    cursor.privateRevision !== binding.revisions.privateRevision
  ) {
    throw new SearchError(
      'stale-continuation',
      'The search results changed after this page was read; start the search again.',
    );
  }
  return cursor.offset;
}

function unreadable(): SearchError {
  return new SearchError(
    'invalid-request',
    'This continuation is not readable; start the search again.',
  );
}

/**
 * Account the continuation is bound to. A query that reads private data needs usable trusted
 * context; a public query binds the supplied account too, so its continuation still belongs to the
 * session that started the result.
 */
function boundAccountId(binding: SearchContinuationBinding): string | null {
  const accountId = readTrustedAccountId(binding.context);
  if (requiresTrustedContext(binding.query) && accountId === null) {
    throw new SearchError(
      'unauthorized',
      'Private search criteria and physical-copy results require authenticated context.',
    );
  }
  return accountId;
}

function isBoundRevision(revision: string | null | undefined): revision is string {
  return (
    typeof revision === 'string' &&
    revision.length > 0 &&
    revision.length <= SEARCH_LIMITS.maxIdentifierLength
  );
}

/**
 * Digest of what makes a continuation belong to one result sequence: the result level, the
 * normalized criteria, the ordering and the account. Operands of a commutative combination are
 * already canonical, so criteria that differ only in order or in the case Scryfall compares
 * case-insensitively produce the same fingerprint.
 */
function searchQueryFingerprint(query: SearchQuery, accountId: string | null): string {
  const canonical = JSON.stringify({
    version: 1,
    resultLevel: query.resultLevel,
    ordering: `${query.ordering.field}:${query.ordering.direction}`,
    account: accountId,
    filters: canonicalizeSearchFilters(query.filters).map(searchFilterKey),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
