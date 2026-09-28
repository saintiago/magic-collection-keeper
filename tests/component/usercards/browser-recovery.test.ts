/** Account teardown, recovery serialization and reconciliation retention through the public facade. */
import { expect, it } from 'vitest';

import { createUserCardsOperations, type UserCardsChange } from '../../../src/usercards/browser.js';
import type {
  ImportOperationRecoveryResult,
  ImportReceipt,
  SourceImportResult,
  StageSourceImportInput,
} from '../../../src/usercards/index.js';
import { unusedUserCardsClient, memoryAttemptStorage } from '../../support/usercards-browser.js';

const input = { sessionId: 'import-1', entries: [{ entryId: 'entry-1', expectedRevision: 1 }] };
const receipt: ImportReceipt = {
  operationId: 'op-1',
  sessionId: 'import-1',
  sourceKind: 'manual',
  sourceId: 'manual',
  publicationPosition: '7',
  copies: [],
};
const failure = (code: string) => Object.assign(new Error(code), { code });

it.each(['committed', 'rejected'] as const)(
  'keeps a %s confirmation stable through recovery, retry and account release',
  async (state) => {
    let writes = 0;
    let reads = 0;
    const facade = createUserCardsOperations({
      identity: () => receipt.operationId,
      client: {
        ...unusedUserCardsClient(),
        confirmImport: async () => {
          writes++;
          if (state === 'rejected') throw failure('conflict');
          return { ...receipt, privateRevision: 'revision-1', replayed: false };
        },
        recoverImportOperation: async () => {
          reads++;
          throw failure('unavailable');
        },
      },
    });
    const account = facade.account('alice');
    const operation = account.confirmImport(input);
    const initial = await operation.observe();
    expect(initial.state).toBe(state);
    expect(account.retained()).toEqual([]);
    expect(await operation.recover()).toEqual(initial);
    expect(await operation.retry()).toEqual(initial);

    facade.release('alice');
    expect(await operation.recover()).toEqual(initial);
    expect(await operation.retry()).toEqual(initial);
    expect(writes).toBe(1);
    expect(reads).toBe(0);
  },
);

it.each(['recover', 'retry'] as const)(
  'coalesces %s with a recorded recovery and publishes its authoritative receipt',
  async (action) => {
    const recovering = Promise.withResolvers<ImportOperationRecoveryResult>();
    let reads = 0;
    let writes = 0;
    const storage = memoryAttemptStorage();
    const facade = createUserCardsOperations({
      storage,
      identity: () => receipt.operationId,
      client: {
        ...unusedUserCardsClient(),
        confirmImport: async () => {
          writes++;
          throw failure('unavailable');
        },
        recoverImportOperation: () => {
          reads++;
          // The automatic recovery fails. Only the first explicit recovery gets the receipt;
          // another request would fail and must not supersede it.
          return reads === 2 ? recovering.promise : Promise.reject(failure('unavailable'));
        },
      },
    });
    const account = facade.account('alice');
    const changes: UserCardsChange[] = [];
    account.subscribe((change) => changes.push(change));
    const operation = account.confirmImport(input);
    expect((await operation.observe()).state).toBe('unknown');
    expect(changes).toEqual([]);

    const first = operation.recover();
    const second = operation[action]();
    const observed = operation.observe();
    recovering.resolve({ outcome: 'recorded', receipt });
    const expected = { state: 'committed', record: { ...receipt, replayed: true } };
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(await observed).toEqual(expected);
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect(changes).toEqual([
      { scope: 'copies', records: [], imports: ['import-1'], position: '7' },
    ]);
    expect(account.retained()).toEqual([]);
    expect(storage.values.size).toBe(0);
  },
);

it('releases the recovery slot after a synchronous provider failure so a later read can recover', async () => {
  let reads = 0;
  const account = createUserCardsOperations({
    identity: () => receipt.operationId,
    client: {
      ...unusedUserCardsClient(),
      confirmImport: async () => {
        throw failure('unavailable');
      },
      recoverImportOperation: () => {
        reads++;
        if (reads < 3) throw failure('unavailable');
        return Promise.resolve({ outcome: 'recorded', receipt });
      },
    },
  }).account('alice');
  const operation = account.confirmImport(input);
  expect((await operation.observe()).state).toBe('unknown');
  expect((await operation.recover()).state).toBe('unknown');
  expect((await operation.recover()).state).toBe('committed');
  expect(reads).toBe(3);
});

it('ignores a late recorded receipt and fences further recovery after account release', async () => {
  const recovering = Promise.withResolvers<ImportOperationRecoveryResult>();
  let reads = 0;
  let writes = 0;
  const facade = createUserCardsOperations({
    client: {
      ...unusedUserCardsClient(),
      confirmImport: async () => {
        writes++;
        throw failure('unavailable');
      },
      recoverImportOperation: () => {
        reads++;
        return reads === 1 ? Promise.reject(failure('unavailable')) : recovering.promise;
      },
    },
  });
  const account = facade.account('alice');
  const changes: UserCardsChange[] = [];
  account.subscribe((change) => changes.push(change));
  const operation = account.confirmImport(input);
  await operation.observe();
  const recovery = operation.recover();
  const observing = operation.observe();
  facade.release('alice');
  expect((await observing).state).toBe('unknown');
  recovering.resolve({ outcome: 'recorded', receipt });
  expect((await recovery).state).toBe('unknown');
  expect((await operation.recover()).state).toBe('unknown');
  expect((await operation.retry()).state).toBe('unknown');
  expect(reads).toBe(2);
  expect(writes).toBe(1);
  expect(changes).toEqual([]);
});

it('releases persisted attempts before opening a reloaded scope, preserving other accounts', async () => {
  const storage = memoryAttemptStorage();
  const client = {
    ...unusedUserCardsClient(),
    stageSourceImport: async () => {
      throw failure('unavailable');
    },
  };
  const original = createUserCardsOperations({ client, storage });
  for (const accountId of ['alice', 'bob']) {
    await original
      .account(accountId)
      .beginSourceImport({ format: 'pasted-list', text: '1 Bolt' })
      .observe();
  }

  const reloaded = createUserCardsOperations({ client, storage });
  reloaded.release('alice');
  expect(reloaded.account('alice').retained()).toEqual([]);
  expect(reloaded.account('bob').retained()).toHaveLength(1);
  const again = createUserCardsOperations({ client, storage });
  expect(again.account('alice').retained()).toEqual([]);
  expect(again.account('bob').retained()).toHaveLength(1);
});

it('retains reconciliation input before dispatch and recovers it under the existing import after reload', async () => {
  const storage = memoryAttemptStorage();
  const request = { format: 'pasted-list', text: '2 Lightning Bolt' } as const;
  const dispatched: StageSourceImportInput[] = [];
  const result: SourceImportResult = {
    privateRevision: 'revision-2',
    session: {
      sessionId: 'existing-import',
      sourceKind: 'pasted-list',
      sourceId: 'existing-import',
      sourceReference: null,
      state: 'pending',
      pendingEntries: 2,
      confirmedEntries: 0,
      discardedEntries: 0,
      revision: 2,
    },
    rows: [],
    staged: 1,
  };
  const client = {
    ...unusedUserCardsClient(),
    stageSourceImport: async (submitted: StageSourceImportInput) => {
      dispatched.push(submitted);
      // Persisted before the request leaves: even a reload during dispatch can reattach.
      const duringDispatch = createUserCardsOperations({ client, storage }).account('alice');
      expect(duringDispatch.resume('existing-import')?.request).toEqual(request);
      if (dispatched.length === 1) throw failure('unavailable');
      return result;
    },
  };
  const account = createUserCardsOperations({ client, storage }).account('alice');
  const operation = account.reopenSourceImport('existing-import', request);
  expect((await operation.observe()).state).toBe('unknown');
  const reloaded = createUserCardsOperations({ client, storage }).account('alice');
  const retained = reloaded.resume('existing-import');
  expect(retained?.request).toEqual(request);
  expect(
    (
      await reloaded
        .reopenSourceImport('existing-import', { ...request, text: '3 Lightning Bolt' })
        .observe()
    ).state,
  ).toBe('rejected');
  expect(dispatched).toHaveLength(1);
  expect(await retained?.recover()).toEqual({ state: 'committed', record: result });
  expect(dispatched).toEqual([
    { ...request, sessionId: 'existing-import' },
    { ...request, sessionId: 'existing-import' },
  ]);
  expect(reloaded.retained()).toEqual([]);
  expect(createUserCardsOperations({ client, storage }).account('alice').retained()).toEqual([]);
});

it('cleans up a definitely rejected source reconciliation', async () => {
  const storage = memoryAttemptStorage();
  const client = {
    ...unusedUserCardsClient(),
    stageSourceImport: async () => {
      throw failure('conflict');
    },
  };
  const account = createUserCardsOperations({ client, storage }).account('alice');
  const operation = account.reopenSourceImport('existing-import', {
    format: 'pasted-list',
    text: '2 Bolt',
  });
  expect((await operation.observe()).state).toBe('rejected');
  expect(account.retained()).toEqual([]);
  expect(createUserCardsOperations({ client, storage }).account('alice').retained()).toEqual([]);
});

it('does not let repeated release or late work of an obsolete scope erase returning account attempts', async () => {
  const storage = memoryAttemptStorage();
  const late = Promise.withResolvers<SourceImportResult>();
  let writes = 0;
  const client = {
    ...unusedUserCardsClient(),
    stageSourceImport: () => {
      writes++;
      return writes === 1 ? late.promise : Promise.reject(failure('unavailable'));
    },
  };
  const facade = createUserCardsOperations({ client, storage });
  const old = facade.account('alice');
  const obsolete = old.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
  old.release();
  const fresh = facade.account('alice');
  const pending = fresh.beginSourceImport({ format: 'pasted-list', text: '2 Lightning Bolt' });
  await pending.observe();
  old.release();
  late.reject(failure('conflict'));
  await obsolete.observe();
  expect(facade.account('alice')).toBe(fresh);
  const reloaded = createUserCardsOperations({ client, storage }).account('alice');
  expect(reloaded.retained().map((attempt) => attempt.operationId)).toEqual([pending.operationId]);
});
