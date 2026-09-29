/** Ended UserCards handles must not use Application's replacement authentication credentials. */
import { expect, it } from 'vitest';

import { createAuthenticatedRequest, createUserCardsClient } from '../../src/application/index.js';
import { createUserCardsOperations } from '../../src/usercards/browser.js';

it('does not send an ended confirmation recovery or retry with the replacement credential', async () => {
  let token = 'alice-token';
  const requests: { method: string; authorization: string | null }[] = [];
  const request = createAuthenticatedRequest({
    baseUrl: 'https://api.example.test',
    token: () => token,
    fetch: async (_url, init) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, authorization: new Headers(init?.headers).get('authorization') });
      return method === 'POST'
        ? Response.json(
            { error: { code: 'conflict', message: 'The entry changed.' } },
            { status: 409 },
          )
        : Response.json({ outcome: 'absent' });
    },
  });
  const facade = createUserCardsOperations({ client: createUserCardsClient(request) });
  const operation = facade.account('alice').confirmImport({
    sessionId: 'import-1',
    destination: { kind: 'ownership' },
    entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
  });
  const rejected = await operation.observe();
  expect(rejected.state).toBe('rejected');
  facade.release('alice');
  request.endSession();
  token = 'bob-token';
  expect(await operation.recover()).toEqual(rejected);
  expect(await operation.retry()).toEqual(rejected);
  expect(requests).toEqual([{ method: 'POST', authorization: 'Bearer alice-token' }]);
});
