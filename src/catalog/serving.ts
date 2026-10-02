/** Catalog's production read implementation, separate from storage/bootstrap exports. */

export {
  createCatalog,
  type CatalogDependencies,
  type CatalogService,
} from './internal/service.js';
