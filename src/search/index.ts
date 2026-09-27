/**
 * Search public entry point (docs/search.md#interface).
 *
 * A request specifies a result level, Scryfall-compatible criteria, ordering, a page size and an
 * optional continuation; a supported text expression and the equivalent UI controls normalize into
 * the same query model, and an expression outside the supported subset is rejected explicitly.
 * Trusted context, not a query field, determines the account, and private criteria or a
 * physical-copy result level require it. A page returns stable entry keys, typed targets, basic
 * information, quantity context and an opaque continuation bound to the normalized criteria, the
 * ordering, the user and the revisions; a stale continuation requires restarting the result
 * (docs/search.md#scryfall-compatibility, docs/search.md#request-and-result). Evaluating the query
 * against the published Catalog and UserCards relations belongs to the search evaluation task.
 * Other components import Search through this module only; its internal modules stay private to
 * the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { SearchError, type SearchFailureCode } from './internal/errors.js';
export {
  SEARCH_LIMITS,
  defaultSearchOrdering,
  isPrivateCriterion,
  requiresTrustedContext,
  searchComparisons,
  searchOrderingFields,
  searchPublicCriterionLevel,
  searchResultLevels,
  searchSortDirections,
  type SearchAndFilter,
  type SearchColorCriterion,
  type SearchColorIdentityCriterion,
  type SearchColorSet,
  type SearchComparison,
  type SearchCriterion,
  type SearchCriterionFilter,
  type SearchCriterionRead,
  type SearchFilter,
  type SearchFinishCriterion,
  type SearchLanguageCriterion,
  type SearchManaValueCriterion,
  type SearchNameCriterion,
  type SearchNotFilter,
  type SearchOrFilter,
  type SearchOrdering,
  type SearchOrderingField,
  type SearchOwnedCriterion,
  type SearchPrivateCriterion,
  type SearchPublicCriterion,
  type SearchQuery,
  type SearchRequestInput,
  type SearchResultLevel,
  type SearchRevisions,
  type SearchRulesTextCriterion,
  type SearchSetCriterion,
  type SearchSortDirection,
  type SearchTagCriterion,
  type SearchTypeCriterion,
} from './internal/model.js';
export { parseScryfallQuery } from './internal/scryfall.js';
export { normalizeSearchRequest } from './internal/request.js';
export {
  decodeSearchContinuation,
  encodeSearchContinuation,
  type SearchContinuationBinding,
} from './internal/continuation.js';
export {
  searchEntryKey,
  type SearchEntry,
  type SearchEntryCard,
  type SearchEntryPrinting,
  type SearchEntryQuantity,
  type SearchEntryTarget,
  type SearchPage,
} from './internal/results.js';
