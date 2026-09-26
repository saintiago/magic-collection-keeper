/**
 * Catalog public entry point (docs/catalog.md#interface).
 *
 * Consumers resolve playable identities and exact printings in bounded batches, list a card's
 * printings, and read the declared query surface (CATALOG_QUERY_SURFACE) that Search joins in the
 * deployed database. Other components import Catalog through this module only; its internal
 * modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { CatalogError, type CatalogFailureCode } from './internal/errors.js';
export type { CatalogSqlExecutor, CatalogSqlRow, CatalogSqlValue } from './internal/executor.js';
export {
  cardColors,
  cardReferenceSchema,
  catalogReferenceSchema,
  CATALOG_LIMITS,
  finishes,
  printingReferenceSchema,
  type CardColor,
  type CardId,
  type CardName,
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
  catalogSchemaSql,
  type CatalogColumnType,
  type CatalogQueryRelation,
  type CatalogQuerySurface,
  type CatalogRelationColumn,
} from './internal/schema.js';
export {
  createCatalog,
  type CardPrintingsPage,
  type Catalog,
  type CatalogDependencies,
  type CatalogResolution,
  type ListCardPrintingsOptions,
} from './internal/service.js';
