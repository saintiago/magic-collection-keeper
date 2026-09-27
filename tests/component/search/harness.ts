/**
 * Helpers shared by the Search component cases: untyped caller input and the SearchError a call
 * fails with.
 */

import { SearchError } from '../../../src/search/index.js';

/** Input as an untyped transport caller could send it, so validation is exercised for real. */
export function callerInput<T>(value: unknown): T {
  return value as T;
}

/** Returns the SearchError a call throws; fails the test for any other outcome. */
export function captureSearchError(run: () => unknown): SearchError {
  try {
    run();
  } catch (cause) {
    if (cause instanceof SearchError) {
      return cause;
    }
    throw cause;
  }
  throw new Error('Expected a SearchError, but the call succeeded.');
}
