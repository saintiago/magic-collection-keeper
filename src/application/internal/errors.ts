/**
 * Translation of provider and environment failures into one Application failure
 * (docs/application.md#interface). The provider error types belong to the backend components, so
 * this module belongs to the backend entry point (src/application/backend.ts); the browser
 * composition imports ./failures.ts instead and never reaches this module.
 */

import { CatalogError } from '../../catalog/contract.js';
import { RecognitionError } from '../../recognition/index.js';
import { UserCardsError } from '../../usercards/contract.js';

import { ApplicationError, isAbortCause } from './failures.js';

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
