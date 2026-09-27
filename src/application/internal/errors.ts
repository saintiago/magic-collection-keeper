/**
 * Application failures and their translation into transport outcomes
 * (docs/application.md#interface, docs/application.md#construction-and-request-boundary).
 *
 * Validation, unauthorized access, a missing record, a revision conflict, a stale continuation,
 * busy work and an unavailable provider stay distinct: no failure is reported as an empty success
 * and none is collapsed into another. A component failure keeps its provider-owned public message;
 * the underlying cause, storage details, credentials and provider exceptions never reach the
 * caller. `timeout` belongs to the transport itself: the deadline elapsed before the operation
 * reported an outcome, so the caller must recover the operation's recorded outcome instead of
 * assuming the write failed. `cancelled` reports that the caller withdrew the invocation.
 */

import { CatalogError } from '../../catalog/index.js';
import { RecognitionError } from '../../recognition/index.js';
import { SearchError } from '../../search/index.js';
import { UserCardsError } from '../../usercards/index.js';

export const applicationFailureCodes = [
  'invalid-request',
  'unsupported-query',
  'unauthorized',
  'not-found',
  'conflict',
  'stale-continuation',
  'busy',
  'cancelled',
  'unavailable',
  'timeout',
  'route-not-found',
  'method-not-allowed',
] as const;

export type ApplicationFailureCode = (typeof applicationFailureCodes)[number];

/** True for a failure code a transport response may carry. */
export function isApplicationFailureCode(value: unknown): value is ApplicationFailureCode {
  return (
    typeof value === 'string' && (applicationFailureCodes as readonly string[]).includes(value)
  );
}

/** Status a caller reads for one failure code; every code stays distinguishable by its body. */
export function transportStatus(code: ApplicationFailureCode): number {
  switch (code) {
    case 'invalid-request':
    case 'unsupported-query':
      return 400;
    case 'unauthorized':
      return 401;
    case 'not-found':
    case 'route-not-found':
      return 404;
    case 'method-not-allowed':
      return 405;
    case 'conflict':
    case 'stale-continuation':
      return 409;
    case 'cancelled':
      return 408;
    case 'busy':
      return 429;
    case 'timeout':
      return 504;
    case 'unavailable':
      return 503;
  }
}

/** One failure Application reports to a transport caller or an entry-point runner. */
export class ApplicationError extends Error {
  readonly code: ApplicationFailureCode;

  constructor(code: ApplicationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

/**
 * Translates any component or environment failure into one Application failure. The owning
 * component's public failure code is preserved; an unrecognized cause is an unavailable operation
 * rather than a success or a different outcome.
 */
export function translateFailure(cause: unknown): ApplicationError {
  if (cause instanceof ApplicationError) {
    return cause;
  }
  if (cause instanceof CatalogError) {
    return new ApplicationError(cause.code, cause.message, { cause });
  }
  if (cause instanceof SearchError) {
    return new ApplicationError(cause.code, cause.message, { cause });
  }
  if (cause instanceof UserCardsError) {
    return new ApplicationError(cause.code, cause.message, { cause });
  }
  if (cause instanceof RecognitionError) {
    return new ApplicationError(cause.code, cause.message, { cause });
  }
  if (isAbortCause(cause)) {
    return new ApplicationError('cancelled', 'The invocation was cancelled.', { cause });
  }
  return new ApplicationError('unavailable', 'The operation could not be completed.', { cause });
}

/** True for the abort reasons an aborted signal carries across the supported runtimes. */
export function isAbortCause(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  const name = Reflect.get(cause, 'name');
  return name === 'AbortError' || name === 'TimeoutError';
}
