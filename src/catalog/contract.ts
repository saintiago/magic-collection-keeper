/** Tree-shakable Catalog service contract for backend consumers. */

export { CatalogError, type CatalogFailureCode } from './internal/errors.js';
export {
  CATALOG_LIMITS,
  cardReferenceSchema,
  catalogReferenceSchema,
  finishes,
  printingReferenceSchema,
  type CardId,
  type CardRecord,
  type CatalogReference,
  type CatalogRevision,
  type Finish,
  type PrintingId,
  type PrintingRecord,
  type PrintingReference,
} from './internal/model.js';
export type {
  CardPrintingsPage,
  Catalog,
  CatalogQueries,
  CatalogResolution,
  CatalogResolver,
  CatalogService,
  ListCardPrintingsOptions,
} from './internal/service.js';
export { findCatalogPrinting, type PrintingLookup } from './internal/printing-lookup.js';
