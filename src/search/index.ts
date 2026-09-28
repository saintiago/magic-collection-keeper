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
 * (docs/search.md#scryfall-compatibility, docs/search.md#request-and-result). Evaluation reads
 * Search's own projection in one read-only statement: membership and grouping run over the
 * complete result before ordering and pagination, translated names keep the matched name for
 * display, and copy counts and intended quantities stay distinct
 * (docs/search.md#required-query-contracts, docs/search.md#evaluation-and-grouping).
 *
 * Search also owns its rebuildable projection: createSearchIndexer consumes the Catalog and
 * UserCards publication contracts as resumable background work, maintains Search's own storage
 * (searchSchemaSql) and publishes a replacement generation only once every source in its scope is
 * caught up and no reference is unresolved (docs/search.md#internal-design,
 * docs/data-architecture.md#asynchronous-synchronization). A result reports whether it has
 * incorporated a required committed position or published catalog revision and stays usable while
 * indexing catches up; observe reads that progress with a bounded, cancellable wait, and
 * createSearchProgress tracks one account's committed positions for the browser's indexing notice
 * (docs/search.md#freshness). Other components import Search through this module only; its
 * internal modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export type {
  SearchSqlExecutor,
  SearchSqlRow,
  SearchSqlTransactor,
  SearchSqlValue,
} from './internal/executor.js';
export { SearchError, type SearchFailureCode } from './internal/errors.js';
export { createSearch, type Search, type SearchDependencies } from './internal/service.js';
export {
  type SearchObservationOptions,
  type SearchProgress,
  type SearchProgressRequest,
  type SearchProgressState,
} from './internal/freshness.js';
export {
  SEARCH_PROGRESS_DEFAULT_WINDOW_MS,
  createSearchProgress,
  type SearchIndexingProgress,
  type SearchIndexingStatus,
  type SearchIndexingProgressDependencies,
} from './internal/progress.js';
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
  type SearchRequiredProgress,
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
  searchCountKey,
  type SearchCount,
  type SearchCountInput,
  type SearchCountReference,
  type SearchCountResult,
  type SearchEntry,
  type SearchEntryCard,
  type SearchEntryPrinting,
  type SearchEntryQuantity,
  type SearchEntryTarget,
  type SearchPage,
} from './internal/results.js';
export {
  SEARCH_INDEXING_LIMITS,
  createSearchIndexer,
  type SearchAccountProgress,
  type SearchCatalogProgress,
  type SearchIndexer,
  type SearchIndexerDependencies,
  type SearchIndexingRequest,
  type SearchIndexingResult,
} from './internal/indexing.js';
export {
  SEARCH_ACCOUNT_SCOPE_SQL,
  SEARCH_ACCOUNT_SETTING,
  SEARCH_PROJECTION_SURFACE,
  searchIndexingGrants,
  searchReaderGrants,
  searchSchemaSql,
  type SearchColumnType,
  type SearchProjectionRelation,
  type SearchProjectionSurface,
  type SearchRelationColumn,
} from './internal/schema.js';
