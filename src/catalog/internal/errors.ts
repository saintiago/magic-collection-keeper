/**
 * Catalog failures that consumers and Application map to transport outcomes. A missing record is
 * never reported as a failure, and a failure is never reported as a missing record: exact lookups
 * return explicit missing references, while an unusable catalog read raises one of these codes.
 */
export type CatalogFailureCode = 'invalid-request' | 'stale-continuation' | 'unavailable';

export class CatalogError extends Error {
  readonly code: CatalogFailureCode;

  constructor(code: CatalogFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogError';
    this.code = code;
  }
}
