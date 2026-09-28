/**
 * Component scope: the UserCards browser operation facade
 * (docs/user-cards.md#browser-operation-lifecycle, docs/testing.md#client-operation-lifecycle).
 *
 * The facade is exercised independently of the UserInterface: attempt retention across a reload,
 * recovery of a recorded outcome, the refusal to infer an import from matching contents, account
 * scoping, revision conflicts, committed-change invalidations and the published constraints.
 */

import { describe, expect, it } from 'vitest';

import {
  createUserCardsOperations,
  type UserCardsAttemptStorage,
  type UserCardsBrowserClient,
  type UserCardsChange,
  type UserCardsOperationOutcome,
} from '../../../src/usercards/browser.js';
import type {
  ImportEntry,
  ImportSession,
  ImportStageResult,
  SourceImportResult,
} from '../../../src/usercards/index.js';

function session(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    sessionId: 'import-1',
    sourceKind: 'pasted-list',
    sourceId: 'import-1',
    sourceReference: null,
    state: 'pending',
    pendingEntries: 1,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 1,
    ...overrides,
  };
}

function entry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'entry-1',
    sessionId: 'import-1',
    position: 1,
    state: 'pending',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [],
    sourceLine: null,
    revision: 1,
    ...overrides,
  };
}

function sourceResult(sessionId: string): SourceImportResult {
  return {
    privateRevision: 'revision-2',
    session: session({ sessionId, sourceId: sessionId }),
    rows: [],
    staged: 0,
  };
}

function stageResult(entries: readonly ImportEntry[] = [entry()]): ImportStageResult {
  return {
    privateRevision: 'revision-2',
    session: session(),
    entries: [...entries],
    staged: entries.length,
    replayed: false,
  };
}

function unavailable(message = 'The service could not be reached.'): Error {
  const cause = new Error(message);
  Object.assign(cause, { code: 'unavailable' });
  return cause;
}

function conflict(message = 'The record changed since you read it.'): Error {
  const cause = new Error(message);
  Object.assign(cause, { code: 'conflict' });
  return cause;
}

/** Storage one account's retained attempts survive a reload in. */
function memoryStorage(): UserCardsAttemptStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** A private client whose named operation is scripted; every other operation rejects visibly. */
function scriptedClient(operations: Partial<UserCardsBrowserClient>): UserCardsBrowserClient {
  const unused = () => Promise.reject(new Error('This case invokes no such UserCards operation.'));
  return {
    readCopies: unused,
    correctCopy: unused,
    listTags: unused,
    readTags: unused,
    createTag: unused,
    renameTag: unused,
    listAssociations: unused,
    readAssociations: unused,
    createAssociation: unused,
    changeAssociation: unused,
    removeAssociation: unused,
    setCopyLocation: unused,
    listImportSessions: unused,
    listImportEntries: unused,
    stageImportEntries: unused,
    stageSourceImport: unused,
    stageCaptureObservation: unused,
    reviewImportEntry: unused,
    attachImportCandidates: unused,
    discardImportEntry: unused,
    discardImportSession: unused,
    confirmImport: unused,
    recoverImportOperation: unused,
    ...operations,
  };
}

/** Deterministic identities, so a case asserts the identity a retry refers to. */
function identities(): () => string {
  let serial = 0;
  return () => {
    serial += 1;
    return `identity-${serial}`;
  };
}

function outcomeOf<Record>(
  outcome: UserCardsOperationOutcome<Record>,
): UserCardsOperationOutcome<Record> {
  return outcome;
}

describe('UserCards browser operations', () => {
  it('keeps an unfinished import under its identity and resumes it after a reload', async () => {
    const storage = memoryStorage();
    const requested: string[] = [];
    const client = scriptedClient({
      stageSourceImport: (input) => {
        requested.push(input.sessionId);
        return Promise.reject(unavailable());
      },
    });
    const first = createUserCardsOperations({
      client,
      storage,
      identity: identities(),
    }).account('alice');

    const lost = first.stageSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await lost.observe()).toEqual({
      state: 'unknown',
      failure: { code: 'unavailable', message: 'The service could not be reached.' },
    });
    expect(requested).toEqual(['identity-1']);

    // A reload builds a new facade over the same browsing-session storage: the unfinished import
    // keeps the identity it composed, and the same input resumes that import instead of staging
    // another one.
    const second = createUserCardsOperations({
      client,
      storage,
      identity: identities(),
    }).account('alice');
    const retained = second.retained();
    expect(retained).toHaveLength(1);
    expect(retained[0]?.kind).toBe('stageSourceImport');
    expect(retained[0]?.operationId).toBe('identity-1');

    const resumed = second.stageSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(resumed.operationId).toBe('identity-1');
    expect(await resumed.observe()).toEqual({
      state: 'unknown',
      failure: { code: 'unavailable', message: 'The service could not be reached.' },
    });
    expect(requested).toEqual(['identity-1', 'identity-1']);
  });

  it('composes a new import for identical contents when the earlier import was established', async () => {
    const requested: string[] = [];
    const client = scriptedClient({
      stageSourceImport: (input) => {
        requested.push(input.sessionId);
        return Promise.resolve(sourceResult(input.sessionId));
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');

    const first = account.stageSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await first.observe()).toMatchObject({ state: 'committed' });
    expect(account.retained()).toEqual([]);

    const second = account.stageSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(second.operationId).not.toBe(first.operationId);
    expect(await second.observe()).toMatchObject({ state: 'committed' });
    expect(requested).toEqual(['identity-1', 'identity-2']);
  });

  it('recovers a lost confirmation through its recorded receipt and publishes one invalidation', async () => {
    const changes: UserCardsChange[] = [];
    let confirmationReads = 0;
    const client = scriptedClient({
      confirmImport: () => Promise.reject(unavailable()),
      recoverImportOperation: async (operationId) => {
        confirmationReads += 1;
        return {
          outcome: 'recorded',
          receipt: {
            operationId,
            sessionId: 'import-1',
            sourceKind: 'pasted-list',
            sourceId: 'import-1',
            publicationPosition: '7',
            copies: [
              {
                copyId: 'copy-1',
                printingId: 'printing-1',
                finish: 'nonfoil',
                condition: null,
                revision: 1,
              },
            ],
          },
        };
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const confirmation = account.confirmImport({
      sessionId: 'import-1',
      entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
    });
    const outcome = await confirmation.observe();

    expect(confirmationReads).toBe(1);
    expect(outcome).toEqual({
      state: 'committed',
      record: expect.objectContaining({
        operationId: confirmation.operationId,
        replayed: true,
      }),
    });
    expect(changes).toEqual([
      {
        scope: 'copies',
        records: [{ kind: 'copy', copyId: 'copy-1' }],
        imports: ['import-1'],
        position: '7',
      },
    ]);
    expect(account.retained()).toEqual([]);
  });

  it('leaves a confirmation unknown, without a speculative invalidation, when the receipt cannot be read', async () => {
    const changes: UserCardsChange[] = [];
    const client = scriptedClient({
      confirmImport: () => Promise.reject(unavailable()),
      recoverImportOperation: () => Promise.reject(unavailable('Offline.')),
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const confirmation = account.confirmImport({
      sessionId: 'import-1',
      entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
    });

    expect(outcomeOf(await confirmation.observe())).toEqual({
      state: 'unknown',
      failure: { code: 'unavailable', message: 'Offline.' },
    });
    expect(changes).toEqual([]);
    expect(account.retained().map((attempt) => attempt.operationId)).toEqual([
      confirmation.operationId,
    ]);
  });

  it('reports a revision conflict as a rejection without an invalidation', async () => {
    const changes: UserCardsChange[] = [];
    const client = scriptedClient({
      reviewImportEntry: () => Promise.reject(conflict()),
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const review = account.reviewImportEntry({
      entryId: 'entry-1',
      expectedRevision: 1,
      printingId: 'printing-1',
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });

    expect(await review.observe()).toEqual({
      state: 'rejected',
      failure: { code: 'conflict', message: 'The record changed since you read it.' },
    });
    expect(changes).toEqual([]);
  });

  it('scopes retained attempts to their account and releases them with that account', async () => {
    const storage = memoryStorage();
    const client = scriptedClient({
      stageSourceImport: () => Promise.reject(unavailable()),
    });
    const operations = createUserCardsOperations({ client, storage, identity: identities() });
    const alice = operations.account('alice');
    const bob = operations.account('bob');

    alice.stageSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    await Promise.resolve();

    expect(alice.retained()).toHaveLength(1);
    expect(bob.retained()).toEqual([]);

    alice.release();
    expect(alice.retained()).toEqual([]);
    expect(storage.values.size).toBe(0);

    // The released account keeps nothing to resume; the other account's scope stays usable.
    const reloaded = createUserCardsOperations({ client, storage, identity: identities() });
    expect(reloaded.account('alice').retained()).toEqual([]);
    expect(reloaded.account('bob').retained()).toEqual([]);
  });

  it('publishes the provider constraints and the operations the deployment enables', () => {
    const client = scriptedClient({});
    const account = createUserCardsOperations({
      client,
      storage: null,
      operations: ['readCopies', 'correctCopy', 'stageImportEntries'],
    }).account('alice');

    expect(account.constraints.operations).toEqual([
      'readCopies',
      'correctCopy',
      'stageImportEntries',
    ]);
    // Request batch bounds stay distinct from product quantity bounds.
    expect(account.constraints.batch.stageEntries).toBe(50);
    expect(account.constraints.batch.confirmEntries).toBe(50);
    expect(account.constraints.quantity.copy).toBe(100);
    expect(account.constraints.quantity.association).toBe(1000);
    expect(account.constraints.text.sourceText).toBe(128 * 1024);
    expect(account.constraints.pages.imports).toEqual({ default: 50, min: 1, max: 100 });

    expect(() => account.stageSourceImport({ format: 'pasted-list', text: 'x' })).toThrow(
      /stageSourceImport/,
    );
  });

  it('replays staged lines under their entry identity and emits the committed change', async () => {
    const changes: UserCardsChange[] = [];
    const staged: string[] = [];
    const client = scriptedClient({
      stageImportEntries: (input) => {
        staged.push(input.entries.map((entry) => entry.entryId).join(' '));
        return Promise.resolve(stageResult());
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const source = { kind: 'manual', id: 'manual' } as const;
    const lines = {
      sessionId: 'manual',
      source,
      entries: [
        {
          entryId: 'line-1',
          printingId: 'printing-1',
          finish: null,
          condition: null,
          quantity: 2,
        },
      ],
    };
    const first = account.stageImportEntries(lines);
    expect(await first.observe()).toMatchObject({ state: 'committed' });
    const second = account.stageImportEntries(lines);
    expect(second.operationId).not.toBe(first.operationId);
    expect(await second.observe()).toMatchObject({ state: 'committed' });

    expect(staged).toEqual(['line-1', 'line-1']);
    expect(changes).toEqual([
      { scope: 'imports', records: [], imports: ['import-1'], position: null },
      { scope: 'imports', records: [], imports: ['import-1'], position: null },
    ]);
  });

  it('publishes the affected record and position of a committed copy or tag change', async () => {
    const changes: UserCardsChange[] = [];
    const client = scriptedClient({
      correctCopy: async () => ({
        privateRevision: 'revision-2',
        publicationPosition: '11',
        copies: [
          {
            copyId: 'copy-1',
            printingId: 'printing-1',
            finish: 'foil',
            condition: null,
            revision: 2,
          },
        ],
      }),
      removeAssociation: async () => ({
        privateRevision: 'revision-3',
        publicationPosition: '12',
        associationId: 'association-1',
      }),
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    await account
      .correctCopy({
        copyId: 'copy-1',
        expectedRevision: 1,
        printingId: 'printing-1',
        finish: 'foil',
        condition: null,
      })
      .observe();
    await account
      .removeAssociation({ associationId: 'association-1', expectedRevision: 3 })
      .observe();

    expect(changes).toEqual([
      {
        scope: 'copies',
        records: [{ kind: 'copy', copyId: 'copy-1' }],
        imports: [],
        position: '11',
      },
      {
        scope: 'associations',
        records: [{ kind: 'association', associationId: 'association-1' }],
        imports: [],
        position: '12',
      },
    ]);
  });

  it('retains a capture observation and recovers its recorded decision by replaying it', async () => {
    const replayed: string[] = [];
    const client = scriptedClient({
      stageCaptureObservation: async (input) => {
        replayed.push(input.captureId);
        return replayed.length === 1
          ? Promise.reject(unavailable())
          : {
              privateRevision: 'revision-2',
              outcome: 'admitted',
              replayed: true,
              session: session({ sessionId: input.sessionId, sourceKind: 'capture' }),
              entry: entry({ entryId: 'capture-1', sessionId: input.sessionId }),
            };
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');

    const observation = {
      sessionId: 'capture-session-1',
      captureId: 'capture-1',
      printingId: 'printing-1',
    };
    const capture = account.stageCaptureObservation(observation);
    expect(await capture.observe()).toMatchObject({ state: 'unknown' });
    expect(account.retained().map((attempt) => attempt.operationId)).toEqual(['capture-1']);

    // The recorded decision is recovered by replaying exactly the retained observation, under the
    // same capture identity.
    expect(await capture.recover()).toMatchObject({
      state: 'committed',
      record: { outcome: 'admitted', replayed: true },
    });
    expect(replayed).toEqual(['capture-1', 'capture-1']);
    expect(account.retained()).toEqual([]);
  });
});
