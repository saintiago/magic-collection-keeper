/**
 * Catalog public entry point (docs/catalog.md#interface).
 *
 * Consumers resolve playable identities and exact printings in bounded batches, list a card's
 * printings, and consume the query publication: a consistent snapshot of the published revision
 * and the durable changes published after a position. Application synchronizes the catalog through
 * its own contract: a configured snapshot source supplies bulk provider text, and one atomic
 * publication replaces the published revision and appends its changes together. Other components
 * import Catalog through this module only; its internal modules stay private to the component
 * (docs/architecture.md, .dependency-cruiser.mjs).
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
export {
  CATALOG_QUERY_SURFACE,
  catalogReaderGrants,
  catalogPublicationGrants,
  catalogSchemaSql,
  type CatalogColumnType,
  type CatalogQueryRelation,
  type CatalogQuerySurface,
  type CatalogRelationColumn,
} from './internal/schema.js';
export {
  CATALOG_PUBLICATION_LIMITS,
  createCatalogPublication,
  type CatalogChange,
  type CatalogChangePosition,
  type CatalogChangesPage,
  type CatalogChangesRequest,
  type CatalogPublication,
  type CatalogPublicationDependencies,
  type CatalogPublishedRecord,
  type CatalogRecordChange,
  type CatalogRecordReference,
  type CatalogRevisionChange,
  type CatalogSnapshotPage,
  type CatalogSnapshotRequest,
} from './internal/query-publication.js';
export {
  createCatalog,
  type CardPrintingsPage,
  type Catalog,
  type CatalogDependencies,
  type CatalogResolution,
  type CatalogResolver,
  type ListCardPrintingsOptions,
} from './internal/service.js';
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
