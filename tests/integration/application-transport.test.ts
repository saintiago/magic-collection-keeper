/**
 * Integration scope: the interactive backend transport through the Application public contract
 * (docs/application.md#interface, docs/application.md#construction-and-request-boundary). The real
 * routes, components and identity verification run over a recording SQL substitute, so each case
 * proves which operation ran, which account it was scoped to, and what the caller received.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApplicationError, type TransportRequest } from '../../src/application/index.js';
import { CatalogError } from '../../src/catalog/index.js';

import {
  claimsFor,
  createRecordingSql,
  createTestApplication,
  testAccount,
  testConfiguration,
  type TestApplication,
} from '../component/application/harness.js';

/** One caller request with the fields the case does not override. */
function callerRequest(overrides: Partial<TransportRequest>): TransportRequest {
  return { method: 'POST', path: '/api/catalog/query', ...overrides };
}

function readError(response: { readonly body: string }): Record<string, unknown> {
  const payload = JSON.parse(response.body) as { readonly error?: Record<string, unknown> };
  if (payload.error === undefined) {
    throw new Error(`Expected an error response, received ${response.body}.`);
  }
  return payload.error;
}

function readPayload<T>(response: { readonly body: string }): T {
  return JSON.parse(response.body) as T;
}

/**
 * Collects unhandled promise rejections for one case. A cancelled invocation must not leave a
 * rejection behind that the Node runtime reports and terminates on.
 */
function trackUnhandledRejections(): {
  readonly seen: readonly unknown[];
  settle(): Promise<void>;
  stop(): void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  return {
    seen,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    stop: () => process.off('unhandledRejection', onUnhandled),
  };
}

describe('application transport', () => {
  let harness: TestApplication;

  beforeEach(() => {
    harness = createTestApplication();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a public operation and reports the component validation failure', async () => {
    const response = await harness.application.handle(
      callerRequest({
        path: '/api/catalog/resolve',
        body: JSON.stringify({ references: 'lightning-bolt' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(readError(response)['code']).toBe('invalid-request');
    expect(harness.sql.statements).toEqual([]);
  });

  it('asks the Catalog contract for the preserved recognition hydration', async () => {
    const response = await harness.application.handle(
      callerRequest({
        method: 'GET',
        path: '/api/card',
        query: { printing: 'printing-m11-149-en', oracle: 'oracle-lightning-bolt' },
      }),
    );

    // The substitute carries no published revision, so the Catalog read is unavailable rather
    // than an empty result; the real envelope is exercised against PostgreSQL in the integration
    // suite.
    expect(response.status).toBe(503);
    expect(readError(response)['code']).toBe('unavailable');
    expect(harness.sql.statements).toHaveLength(1);
  });

  it('rejects a private operation without identity and never reaches storage', async () => {
    const response = await harness.application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        body: JSON.stringify({ copyIds: ['copy-1'], ownerId: 'cognito-bob' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(readError(response)['code']).toBe('unauthorized');
    expect(harness.sql.statements).toEqual([]);
  });

  it.each([
    ['another issuer', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other' }],
    ['another audience', { aud: 'another-client' }],
    ['another token kind', { token_use: 'refresh' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['a missing subject', { sub: '' }],
  ])('rejects identity for %s before any private operation', async (_label, claims) => {
    const response = await harness.application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        authentication: { claims: claimsFor(testAccount, claims) },
        body: JSON.stringify({ copyIds: ['copy-1'] }),
      }),
    );

    expect(response.status).toBe(401);
    expect(readError(response)['code']).toBe('unauthorized');
    expect(harness.sql.statements).toEqual([]);
  });

  it('derives the account from the verified claims, never from the request body', async () => {
    const response = await harness.application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        authentication: { claims: claimsFor(testAccount) },
        body: JSON.stringify({
          copyIds: ['copy-1'],
          ownerId: 'cognito-bob',
          accountId: 'cognito-bob',
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(readError(response)['code']).toBe('unavailable');
    expect(harness.sql.statements).toHaveLength(1);
    expect(harness.sql.statements[0]?.parameters['account_id']).toBe(testAccount);
  });

  it('runs a public operation anonymously when the caller presents no identity', async () => {
    const response = await harness.application.handle(
      callerRequest({
        body: JSON.stringify({ resultLevel: 'card', query: 'name:lightning' }),
      }),
    );

    expect(response.status).not.toBe(401);
    expect(harness.sql.statements).toHaveLength(1);
  });

  it('lists one tag’s association page for the verified account through its route', async () => {
    const response = await harness.application.handle(
      callerRequest({
        method: 'GET',
        path: '/api/collection/tags/tag-1/associations',
        query: { pageSize: '2' },
        authentication: { claims: claimsFor(testAccount) },
      }),
    );

    // The recording executor answers no rows, so the component reports its read as unreadable; the
    // statement it ran is scoped to the verified account and carries the requested page bound.
    expect(response.status).toBe(503);
    expect(harness.sql.statements).toHaveLength(1);
    expect(harness.sql.statements[0]?.parameters['account_id']).toBe(testAccount);
    expect(harness.sql.statements[0]?.parameters['tag_id']).toBe('tag-1');
    expect(harness.sql.statements[0]?.parameters['offset']).toBe(0);
    expect(harness.sql.statements[0]?.parameters['limit']).toBe(3);
  });

  it('rejects an association page of a tag route without identity', async () => {
    const response = await harness.application.handle(
      callerRequest({
        method: 'GET',
        path: '/api/collection/tags/tag-1/associations',
      }),
    );

    expect(response.status).toBe(401);
    expect(readError(response)['code']).toBe('unauthorized');
    expect(harness.sql.statements).toEqual([]);
  });

  it('keeps an unsupported query and unauthorized private criteria distinct', async () => {
    const unsupported = await harness.application.handle(
      callerRequest({ body: JSON.stringify({ resultLevel: 'card', query: 'banned:1' }) }),
    );
    const unauthorized = await harness.application.handle(
      callerRequest({
        path: '/api/collection/query',
        body: JSON.stringify({ scope: { kind: 'collection' }, resultLevel: 'card' }),
      }),
    );

    expect(unsupported.status).toBe(400);
    expect(readError(unsupported)['code']).toBe('unsupported-query');
    expect(unauthorized.status).toBe(401);
    expect(readError(unauthorized)['code']).toBe('unauthorized');
    expect(harness.sql.statements).toEqual([]);
  });

  it('rejects unverifiable identity instead of downgrading a public operation to anonymous', async () => {
    const response = await harness.application.handle(
      callerRequest({
        authentication: {
          claims: claimsFor(testAccount, { exp: Math.floor(Date.now() / 1000) - 60 }),
        },
        body: JSON.stringify({ resultLevel: 'card', query: 'name:lightning' }),
      }),
    );

    expect(response.status).toBe(401);
    expect(readError(response)['code']).toBe('unauthorized');
    expect(harness.sql.statements).toEqual([]);
  });

  it('keeps an unknown path distinct from a method the operation does not accept', async () => {
    const unknown = await harness.application.handle(
      callerRequest({ method: 'GET', path: '/api/nothing' }),
    );
    const wrongMethod = await harness.application.handle(
      callerRequest({ method: 'GET', path: '/api/collection/copies' }),
    );

    expect(unknown.status).toBe(404);
    expect(readError(unknown)['code']).toBe('route-not-found');
    expect(wrongMethod.status).toBe(405);
    expect(readError(wrongMethod)['code']).toBe('method-not-allowed');
    expect(harness.sql.statements).toEqual([]);
  });

  it('does not expose the catalog job or the recognition compute entry point', async () => {
    for (const path of [
      '/api/catalog/synchronize',
      '/api/recognize',
      '/api/recognize-independent',
    ]) {
      const response = await harness.application.handle(callerRequest({ path, body: '{}' }));
      expect(response.status).toBe(404);
      expect(readError(response)['code']).toBe('route-not-found');
    }
    expect(harness.sql.statements).toEqual([]);
  });

  it('rejects unreadable transport input before any operation runs', async () => {
    for (const body of ['not json', '[1,2]', '"text"', 'null']) {
      const response = await harness.application.handle(
        callerRequest({
          path: '/api/collection/copies/read',
          authentication: { claims: claimsFor(testAccount) },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(readError(response)['code']).toBe('invalid-request');
    }
    expect(harness.sql.statements).toEqual([]);
  });

  it('reports an unavailable provider without collapsing it into an empty success', async () => {
    const sql = createRecordingSql(() => {
      throw new CatalogError('unavailable', 'The catalog could not be read.');
    });
    const application = createTestApplication({ sql }).application;

    const response = await application.handle(
      callerRequest({ method: 'GET', path: '/api/card', query: { printing: 'printing-1' } }),
    );

    expect(response.status).toBe(503);
    expect(readError(response)['code']).toBe('unavailable');
  });

  it('reports a deadline as an unknown outcome with the operation to recover', async () => {
    vi.useFakeTimers();
    const configuration = testConfiguration();
    configuration.transport.requestTimeoutMs = 50;
    let hanging = true;
    const sql = createRecordingSql(() => (hanging ? new Promise(() => {}) : []));
    const { application, diagnostics } = createTestApplication({ configuration, sql });

    const pending = application.handle(
      callerRequest({
        path: '/api/collection/imports/session-1/confirmation',
        authentication: { claims: claimsFor(testAccount) },
        requestId: 'request-1',
        body: JSON.stringify({
          operationId: 'operation-1',
          destination: { kind: 'ownership' },
          entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(60);
    const response = await pending;

    expect(response.status).toBe(504);
    const error = readError(response);
    expect(error['code']).toBe('timeout');
    expect(error['recovery']).toEqual({ operationId: 'operation-1' });
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'usercards.confirmImport',
        requestId: 'request-1',
        outcome: 'failed',
        failureCode: 'timeout',
      }),
    );
    expect(vi.getTimerCount()).toBe(0);

    hanging = false;
    const recovered = await application.handle(
      callerRequest({
        method: 'GET',
        path: '/api/collection/imports/operations/operation-1',
        authentication: { claims: claimsFor(testAccount) },
      }),
    );
    expect(recovered.status).toBe(200);
    expect(readPayload<{ readonly outcome: string }>(recovered).outcome).toBe('absent');
  });

  it('reports a withdrawn invocation as cancelled without running the operation', async () => {
    const controller = new AbortController();
    controller.abort();

    const response = await harness.application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        authentication: { claims: claimsFor(testAccount) },
        body: JSON.stringify({ copyIds: ['copy-1'] }),
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(408);
    expect(readError(response)['code']).toBe('cancelled');
    expect(harness.sql.statements).toEqual([]);
  });

  it('does not start or abandon identity verification of a withdrawn invocation', async () => {
    const rejections = trackUnhandledRejections();
    try {
      const controller = new AbortController();
      controller.abort();
      const verify = vi.fn(async () => {
        throw new Error('identity provider unavailable');
      });
      const { application } = createTestApplication({ identity: { verify } });

      const response = await application.handle(
        callerRequest({
          path: '/api/collection/copies/read',
          authentication: { claims: claimsFor(testAccount) },
          body: JSON.stringify({ copyIds: ['copy-1'] }),
          signal: controller.signal,
        }),
      );

      expect(response.status).toBe(408);
      expect(readError(response)['code']).toBe('cancelled');
      expect(verify).not.toHaveBeenCalled();
      await rejections.settle();
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it('observes a route failure that follows the cancellation it caused', async () => {
    const rejections = trackUnhandledRejections();
    try {
      const controller = new AbortController();
      const sql = createRecordingSql(() => {
        controller.abort();
        throw new CatalogError('unavailable', 'The provider aborted the invocation.');
      });
      const { application } = createTestApplication({ sql });

      const response = await application.handle(
        callerRequest({
          method: 'GET',
          path: '/api/card',
          query: { printing: 'printing-1' },
          signal: controller.signal,
        }),
      );

      expect(response.status).toBe(408);
      expect(readError(response)['code']).toBe('cancelled');
      await rejections.settle();
      expect(rejections.seen).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it('keeps concurrent invocations of two accounts isolated', async () => {
    const releases: Array<() => void> = [];
    const sql = createRecordingSql(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve([]));
        }),
    );
    const { application } = createTestApplication({ sql });
    const alice = application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        authentication: { claims: claimsFor('cognito-alice') },
        body: JSON.stringify({ copyIds: ['copy-1'] }),
      }),
    );
    const bob = application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        authentication: { claims: claimsFor('cognito-bob') },
        body: JSON.stringify({ copyIds: ['copy-1'] }),
      }),
    );
    await vi.waitFor(() => {
      expect(sql.statements).toHaveLength(2);
    });
    for (const release of releases) {
      release();
    }
    await Promise.all([alice, bob]);

    expect(sql.statements.map((entry) => entry.parameters['account_id'])).toEqual([
      'cognito-alice',
      'cognito-bob',
    ]);
  });

  it('records only the operation and its outcome', async () => {
    const diagnostics = vi.fn();
    const { application } = createTestApplication({ diagnostics });

    await application.handle(
      callerRequest({
        path: '/api/collection/copies',
        authentication: { claims: claimsFor(testAccount) },
        requestId: 'request-9',
        body: JSON.stringify({
          printingId: 'printing-top-secret-note',
          finish: 'nonfoil',
          condition: null,
          quantity: 'many',
        }),
      }),
    );

    const events = diagnostics.mock.calls.map((call) => call[0]);
    expect(events).toEqual([
      expect.objectContaining({
        operation: 'usercards.createCopies',
        requestId: 'request-9',
        outcome: 'failed',
        failureCode: 'invalid-request',
        durationMs: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('top-secret-note');
    expect(JSON.stringify(events)).not.toContain(testAccount);
  });

  it('keeps serving when the diagnostics sink fails', async () => {
    const diagnostics = vi.fn(() => {
      throw new Error('sink unavailable');
    });
    const { application } = createTestApplication({ diagnostics });

    const response = await application.handle(
      callerRequest({
        path: '/api/collection/copies/read',
        body: JSON.stringify({ copyIds: ['copy-1'] }),
      }),
    );

    expect(response.status).toBe(401);
    expect(readError(response)['code']).toBe('unauthorized');
  });

  it('releases the invocation deadline when the operation finishes', async () => {
    vi.useFakeTimers();

    await harness.application.handle(
      callerRequest({ method: 'GET', path: '/api/card', query: { printing: 'printing-1' } }),
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables source imports when the capability is off', async () => {
    const configuration = testConfiguration();
    configuration.capabilities.sourceImports = false;
    const { application, sql } = createTestApplication({ configuration });

    const response = await application.handle(
      callerRequest({
        path: '/api/collection/imports/sources',
        authentication: { claims: claimsFor(testAccount) },
        body: JSON.stringify({
          format: 'pasted-list',
          sourceId: 'list-1',
          text: '1 Lightning Bolt',
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect(readError(response)['code']).toBe('unavailable');
    expect(sql.statements).toEqual([]);
  });

  it('reports the finite catalog job failure and stops serving after disposal', async () => {
    await expect(harness.application.synchronizeCatalog({ dataset: '' })).rejects.toThrow(
      ApplicationError,
    );

    harness.application.dispose();
    await expect(
      harness.application.handle(callerRequest({ method: 'GET', path: '/api/card' })),
    ).rejects.toThrow(ApplicationError);
    await expect(
      harness.application.synchronizeCatalog({ dataset: 'default_cards' }),
    ).rejects.toThrow(ApplicationError);
  });
});
