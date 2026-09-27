import { z } from 'zod';

import type { TrustedUserContext } from '../../usercards/index.js';
import { readTrustedAccountId } from './context.js';
import { SearchError } from './errors.js';
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
  type SearchRequestInput,
} from './model.js';
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
    default:
      return 'A search request with a result level, criteria, ordering and page size is required.';
  }
}
