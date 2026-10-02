/**
 * Component scope: consistent failure translation (docs/application.md#interface). Every
 * provider-owned failure keeps its own code and status; an unrecognized cause is unavailable, and
 * no provider message, cause or credential reaches the caller.
 */

import { describe, expect, it } from 'vitest';

import { translateFailure } from '../../../src/application/backend.js';
import {
  ApplicationError,
  transportStatus,
  type ApplicationFailureCode,
} from '../../../src/application/index.js';
import { CatalogError } from '../../../src/catalog/index.js';
import { RecognitionError } from '../../../src/recognition/index.js';
import { UserCardsError } from '../../../src/usercards/index.js';

describe('failure translation', () => {
  it.each<[ApplicationError, ApplicationFailureCode, number]>([
    [
      new CatalogError('invalid-request', 'The catalog request is invalid.'),
      'invalid-request',
      400,
    ],
    [
      new CatalogError('stale-continuation', 'Restart the printing list.'),
      'stale-continuation',
      409,
    ],
    [new CatalogError('busy', 'Another publication is running.'), 'busy', 429],
    [new CatalogError('unavailable', 'The catalog is unavailable.'), 'unavailable', 503],
    [
      new CatalogError('unsupported-query', 'The expression is not supported.'),
      'unsupported-query',
      400,
    ],
    [new CatalogError('stale-continuation', 'Restart the search.'), 'stale-continuation', 409],
    [new CatalogError('unavailable', 'The search could not run.'), 'unavailable', 503],
    [new UserCardsError('invalid-request', 'The change is invalid.'), 'invalid-request', 400],
    [new UserCardsError('not-found', 'The record does not exist.'), 'not-found', 404],
    [new UserCardsError('conflict', 'The record changed.'), 'conflict', 409],
    [new UserCardsError('unavailable', 'The change could not be stored.'), 'unavailable', 503],
    [new RecognitionError('invalid-request', 'The capture is invalid.'), 'invalid-request', 400],
    [new RecognitionError('busy', 'Scanner busy.'), 'busy', 429],
    [new RecognitionError('cancelled', 'The capture was cancelled.'), 'cancelled', 408],
    [new RecognitionError('unavailable', 'Recognition is unavailable.'), 'unavailable', 503],
  ])('keeps the provider failure distinct', (cause, code, status) => {
    const failure = translateFailure(cause);

    expect(failure.code).toBe(code);
    expect(failure.message).toBe(cause.message);
    expect(transportStatus(failure.code)).toBe(status);
  });

  it('passes an Application failure through unchanged', () => {
    const failure = new ApplicationError('timeout', 'Unknown outcome.');

    expect(translateFailure(failure)).toBe(failure);
  });

  it('reports an unrecognized cause as unavailable without exposing it', () => {
    const failure = translateFailure(new Error('provider said: credential super-secret-token'));

    expect(failure.code).toBe('unavailable');
    expect(failure.message).not.toContain('super-secret-token');
    expect(transportStatus(failure.code)).toBe(503);
  });
});
