import { z } from 'zod';

import type { TrustedUserContext } from '../../usercards/index.js';
import { readTrustedAccountId } from './context.js';
import { SearchError } from './errors.js';
import type { SearchProgressRequest } from './freshness.js';
import {
  SEARCH_LIMITS,
  canonicalizeSearchFilters,
  defaultSearchOrdering,
  readSearchCriterion,
  requiresTrustedContext,
  searchOrderingFields,
  searchResultLevels,
  searchSortDirections,
  type SearchFilter,
  type SearchQuery,
  type SearchRequiredProgress,
  type SearchRequestInput,
} from './model.js';
import { searchCountKey, type SearchCountInput, type SearchCountReference } from './results.js';
import { parseScryfallQuery } from './scryfall.js';

const requestSchema = z.object({
  resultLevel: z.enum(searchResultLevels),
  query: z.string().max(SEARCH_LIMITS.maxQueryLength).nullable().optional(),
  criteria: z.array(z.unknown()).max(SEARCH_LIMITS.maxCriteria).nullable().optional(),
  ordering: z
    .object({
      field: z.enum(searchOrderingFields),
      direction: z.enum(searchSortDirections),
    })
    .nullable()
    .optional(),
  pageSize: z
    .number()
    .int()
    .min(SEARCH_LIMITS.minPageSize)
    .max(SEARCH_LIMITS.maxPageSize)
    .nullable()
    .optional(),
  continuation: z.string().min(1).max(SEARCH_LIMITS.maxContinuationLength).nullable().optional(),
  requiredPosition: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable()
    .optional(),
  requiredCatalogRevision: z
    .string()
    .min(1)
    .max(SEARCH_LIMITS.maxIdentifierLength)
    .nullable()
    .optional(),
});

/**
 * Normalizes one search request into the query model (docs/search.md#request-and-result).
 *
 * A supported text expression and the structured criteria normalize into the same filters, so a
 * UI control and its text equivalent select the same entries. The account never becomes part of
 * the query: a copy-level request or any private criterion needs usable trusted context and
 * otherwise fails as unauthorized before any private read. The continuation stays with the
 * request; evaluation decodes it against the revisions it read.
 */
export function normalizeSearchRequest(
  request: SearchRequestInput,
  context?: TrustedUserContext | null,
): SearchQuery {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SearchError('invalid-request', requestProblem(parsed.error));
  }

  const filters: SearchFilter[] = [];
  const text = parsed.data.query?.trim() ?? '';
  if (text.length > 0) {
    const expression = parseScryfallQuery(text);
    filters.push(...(expression.kind === 'and' ? expression.operands : [expression]));
  }
  for (const candidate of parsed.data.criteria ?? []) {
    const read = readSearchCriterion(candidate);
    if (!read.ok) {
      throw new SearchError('invalid-request', read.problem);
    }
    filters.push({ kind: 'criterion', criterion: read.criterion });
  }

  const query: SearchQuery = {
    resultLevel: parsed.data.resultLevel,
    filters: canonicalizeSearchFilters(filters),
    ordering: parsed.data.ordering ?? defaultSearchOrdering,
    pageSize: parsed.data.pageSize ?? SEARCH_LIMITS.defaultPageSize,
    required: {
      positions:
        parsed.data.requiredPosition === undefined || parsed.data.requiredPosition === null
          ? []
          : [parsed.data.requiredPosition],
      catalogRevision: parsed.data.requiredCatalogRevision ?? null,
    },
  };
  if (requiresTrustedContext(query) && readTrustedAccountId(context) === null) {
    throw new SearchError(
      'unauthorized',
      'Private search criteria and physical-copy results require authenticated context.',
    );
  }
  return query;
}

function requestProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path[0];
  switch (field) {
    case 'resultLevel':
      return `A search result level of ${searchResultLevels.join(', ')} is required.`;
    case 'query':
      return `A search expression of at most ${SEARCH_LIMITS.maxQueryLength} characters is required.`;
    case 'criteria':
      return `A search request carries at most ${SEARCH_LIMITS.maxCriteria} structured criteria.`;
    case 'ordering':
      return `Search ordering needs a ${searchOrderingFields.join(' or ')} field and an ${searchSortDirections.join(' or ')} direction.`;
    case 'pageSize':
      return `A search page size from ${SEARCH_LIMITS.minPageSize} to ${SEARCH_LIMITS.maxPageSize} is required.`;
    case 'continuation':
      return 'This continuation is not readable; start the search again.';
    case 'requiredPosition':
      return 'A required publication position is a whole number of at most 20 digits.';
    case 'requiredCatalogRevision':
      return `A required catalog revision is at most ${SEARCH_LIMITS.maxIdentifierLength} characters.`;
    default:
      return 'A search request with a result level, criteria, ordering and page size is required.';
  }
}

const countReferenceSchema = z.union([
  z.object({
    kind: z.literal('card'),
    cardId: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength),
  }),
  z.object({
    kind: z.literal('printing'),
    printingId: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength),
  }),
  z.object({
    kind: z.literal('copy'),
    copyId: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength),
  }),
]);

const countRequestSchema = z.object({
  references: z.array(countReferenceSchema).min(1).max(SEARCH_LIMITS.maxCountReferences),
  tagId: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength).nullable().optional(),
});

const progressRequestSchema = z.object({
  positions: z
    .array(z.string().regex(/^\d{1,20}$/))
    .max(SEARCH_LIMITS.maxRequiredPositions)
    .nullable()
    .optional(),
  catalogRevision: z.string().min(1).max(SEARCH_LIMITS.maxIdentifierLength).nullable().optional(),
});

/**
 * Normalizes one progress observation (docs/search.md#freshness). The required positions stay
 * explicit and bounded and repeated identities collapse, so one committed change is observed
 * once; nothing here starts indexing work or changes a query's membership.
 */
export function normalizeSearchProgressRequest(
  request: SearchProgressRequest,
): SearchRequiredProgress {
  const parsed = progressRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SearchError(
      'invalid-request',
      `A progress observation carries up to ${SEARCH_LIMITS.maxRequiredPositions} whole-number ` +
        `publication positions of at most ${SEARCH_LIMITS.maxPositionLength} digits and at most ` +
        'one catalog revision.',
    );
  }
  return {
    positions: [...new Set(parsed.data.positions ?? [])],
    catalogRevision: parsed.data.catalogRevision ?? null,
  };
}

/** One normalized private count request: distinct references and the tag whose intent is read. */
export interface SearchCountQuery {
  readonly references: readonly SearchCountReference[];
  readonly tagId: string | null;
}

/**
 * Normalizes one private count request (docs/search.md#request-and-result). The references stay
 * explicit and bounded and repeat identities collapse, so one entry is counted once; a missing or
 * unusable reference never becomes an unnoted zero.
 */
export function normalizeSearchCountRequest(request: SearchCountInput): SearchCountQuery {
  const parsed = countRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SearchError(
      'invalid-request',
      `A count request carries 1 to ${SEARCH_LIMITS.maxCountReferences} card, printing or copy ` +
        `references of at most ${SEARCH_LIMITS.maxIdentifierLength} characters, and at most one tag.`,
    );
  }
  const references = new Map<string, SearchCountReference>();
  for (const reference of parsed.data.references) {
    references.set(searchCountKey(reference), reference);
  }
  return { references: [...references.values()], tagId: parsed.data.tagId ?? null };
}
