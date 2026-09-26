/**
 * Catalog failures that consumers and Application map to transport outcomes. A missing record is
 * never reported as a failure, and a failure is never reported as a missing record: exact lookups
 * return explicit missing references, while an unusable catalog read raises one of these codes.
 * Synchronization reports `busy` when another publication holds the catalog lock and `unavailable`
 * when the requested snapshot or the database cannot be used; either failure leaves the last valid
 * revision published (docs/catalog.md#synchronization).
 */
export type CatalogFailureCode = 'invalid-request' | 'stale-continuation' | 'busy' | 'unavailable';

export class CatalogError extends Error {
  readonly code: CatalogFailureCode;

  constructor(code: CatalogFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogError';
    this.code = code;
  }
}
