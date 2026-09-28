/**
 * Search browser entry point (docs/search.md#freshness, docs/architecture.md).
 *
 * Application's browser composition connects the account's known committed UserCards publication
 * positions to the account-scoped progress tracker and supplies the tracker's observable status to
 * the UserInterface shell; the tracker decides indexing, incorporated, delayed, unavailable and
 * failed states and performs no query or indexing work. Only browser-safe capabilities are
 * published here, so a browser bundle never reaches the component's query or indexing storage. The
 * component's backend contract stays `src/search/index.ts`; other components import Search through
 * these public entry points only (docs/architecture.md, .dependency-cruiser.mjs).
 */

export {
  SEARCH_PROGRESS_DEFAULT_WINDOW_MS,
  createSearchProgress,
  type SearchIndexingProgress,
  type SearchIndexingProgressDependencies,
  type SearchIndexingStatus,
} from './internal/progress.js';
export type {
  SearchProgress,
  SearchProgressRequest,
  SearchProgressState,
} from './internal/freshness.js';
