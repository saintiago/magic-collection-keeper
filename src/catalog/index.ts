/**
 * Catalog public entry point (docs/catalog.md#interface).
 *
 * Consumers query current public card/printing membership, resolve playable identities and exact
 * printings in bounded batches, and list a card's current printings. The transitional publication
 * contract remains exported while its consumers are replaced. Application synchronizes the catalog
 * through its own contract: a configured snapshot source supplies bulk provider text, and one
 * atomic publication replaces current membership without discarding historical references. Other
 * components import Catalog through this module only; its internal modules stay private to the
 * component (docs/catalog.md, docs/architecture.md, .dependency-cruiser.mjs).
 */

export { CatalogError, type CatalogFailureCode } from './internal/errors.js';
export type {
  CatalogSqlExecutor,
  CatalogSqlRow,
  CatalogSqlTransactor,
  CatalogSqlValue,
} from './internal/executor.js';
export {
  cardColors,
  cardReferenceSchema,
  catalogReferenceSchema,
  CATALOG_LIMITS,
  finishes,
  printingReferenceSchema,
  type CardColor,
  type CardFacts,
  type CardId,
  type CardName,
  type CardNameRecord,
  type CardRecord,
  type CardReference,
  type CatalogReference,
  type CatalogRevision,
  type Finish,
  type LanguageCode,
  type PrintingId,
  type PrintingImages,
  type PrintingRecord,
  type PrintingReference,
} from './internal/model.js';
export { catalogReaderGrants, catalogSchemaSql } from './internal/schema.js';
export {
  createCatalog,
  type CardPrintingsPage,
  type Catalog,
  type CatalogDependencies,
  type CatalogQueries,
  type CatalogResolution,
  type CatalogResolver,
  type CatalogService,
  type ListCardPrintingsOptions,
} from './internal/service.js';
export {
  catalogEntryKey,
  normalizeCatalogQuery,
  type CatalogEntry,
  type CatalogEntryCard,
  type CatalogEntryTarget,
  type CatalogQueryPage,
} from './internal/query.js';
export {
  CATALOG_QUERY_LIMITS,
  canonicalCatalogFilter,
  canonicalizeCatalogFilters,
  catalogComparisons,
  catalogCriterionLevel,
  catalogFilterKey,
  catalogOrderingFields,
  catalogResultLevels,
  catalogSortDirections,
  defaultCatalogOrdering,
  isCatalogComparison,
  readCatalogCriterion,
  type CatalogAndFilter,
  type CatalogColorCriterion,
  type CatalogColorIdentityCriterion,
  type CatalogColorSet,
  type CatalogComparison,
  type CatalogCriterion,
  type CatalogCriterionFilter,
  type CatalogCriterionRead,
  type CatalogFilter,
  type CatalogFinishCriterion,
  type CatalogLanguageCriterion,
  type CatalogManaValueCriterion,
  type CatalogNameCriterion,
  type CatalogNotFilter,
  type CatalogOrdering,
  type CatalogOrderingField,
  type CatalogOrFilter,
  type CatalogQuery,
  type CatalogQueryInput,
  type CatalogResultLevel,
  type CatalogRulesTextCriterion,
  type CatalogSetCriterion,
  type CatalogSortDirection,
  type CatalogTypeCriterion,
} from './internal/query-model.js';
export { parseScryfallQuery as parseCatalogQuery } from './internal/query-language.js';
export {
  CATALOG_SYNCHRONIZATION_LIMITS,
  type CatalogSnapshot,
  type CatalogSnapshotSource,
  type CatalogSynchronizationRequest,
} from './internal/snapshot.js';
export {
  createCatalogSynchronizer,
  type CatalogSynchronizationDependencies,
  type CatalogSynchronizer,
} from './internal/sync.js';

export { findCatalogPrinting, type PrintingLookup } from './internal/printing-lookup.js';
