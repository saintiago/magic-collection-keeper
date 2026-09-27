/**
 * Search failures that consumers and Application map to transport outcomes. Invalid criteria,
 * unsupported expressions, unauthorized private access, a stale continuation and a temporary
 * evaluation failure stay distinct; only a successful evaluation can return an empty page
 * (docs/search.md#request-and-result, docs/search.md#scryfall-compatibility).
 */
export type SearchFailureCode =
  'invalid-request' | 'unsupported-query' | 'unauthorized' | 'stale-continuation' | 'unavailable';

export class SearchError extends Error {
  readonly code: SearchFailureCode;

  constructor(code: SearchFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchError';
    this.code = code;
  }
}
