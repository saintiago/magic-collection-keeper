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
  CopyChangeResult,
  ImportConfirmationResult,
  ImportEntry,
  ImportSession,
  ImportStageResult,
  SourceImportResult,
  TagChangeResult,
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
    cardId: 'card-1',
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

/** One client call a case settles by hand, so it can observe an attempt while it is in flight. */
function pendingCall<Value>(): {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(cause: unknown): void;
} {
  let resolve: (value: Value) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function tag(tagId = 'tag-1'): TagChangeResult {
  return {
    privateRevision: 'revision-2',
    publicationPosition: '3',
    tag: { tagId, kind: 'deck', label: 'Deck', system: false, revision: 1 },
  };
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

    const lost = first.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await lost.observe()).toEqual({
      state: 'unknown',
      failure: { code: 'unavailable', message: 'The service could not be reached.' },
    });
    expect(requested).toEqual(['identity-1']);

    // A reload builds a new facade over the same browsing-session storage: the unfinished import
    // keeps the identity it composed, and reopening that identity reads its recorded rows instead
    // of staging another import.
    const second = createUserCardsOperations({
      client,
      storage,
      identity: identities(),
    }).account('alice');
    const retained = second.retained();
    expect(retained).toHaveLength(1);
    expect(retained[0]?.kind).toBe('stageSourceImport');
    expect(retained[0]?.operationId).toBe('identity-1');

    const resumed = second.reopenSourceImport('identity-1', {
      format: 'pasted-list',
      text: '1 Lightning Bolt',
    });
    expect(resumed.operationId).toBe('identity-1');
    expect(await resumed.observe()).toEqual({
      state: 'unknown',
      failure: { code: 'unavailable', message: 'The service could not be reached.' },
    });
    expect(requested).toEqual(['identity-1', 'identity-1']);
  });

  it('begins a distinct import for identical contents, even while the first is unresolved', async () => {
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

    const first = account.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await first.observe()).toMatchObject({ state: 'committed' });
    expect(account.retained()).toEqual([]);

    const second = account.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
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
            destination: { kind: 'ownership' },
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
            associations: [],
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
      destination: { kind: 'ownership' } as const,
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

  it('publishes the recorded associations of a tag confirmation as an association invalidation', async () => {
    const changes: UserCardsChange[] = [];
    const client = scriptedClient({
      confirmImport: async (input) => ({
        privateRevision: 'revision-2',
        replayed: false,
        operationId: input.operationId,
        sessionId: input.sessionId,
        sourceKind: 'moxfield',
        sourceId: 'deck-1',
        destination: input.destination,
        publicationPosition: '9',
        copies: [],
        associations: [
          {
            associationId: 'association-1',
            tagId: 'tag-burn',
            targetLevel: 'card' as const,
            targetId: 'card-bolt',
            quantity: 4,
            revision: 1,
          },
        ],
      }),
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const confirmation = account.confirmImport({
      sessionId: 'import-1',
      destination: { kind: 'tag', tagId: 'tag-burn' },
      entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
    });
    expect((await confirmation.observe()).state).toBe('committed');

    // A tag destination reports the associations it recorded under the association scope; a copy
    // scope would report a change this confirmation never made.
    expect(changes).toEqual([
      {
        scope: 'associations',
        records: [{ kind: 'association', associationId: 'association-1' }],
        imports: ['import-1'],
        position: '9',
      },
    ]);
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
      destination: { kind: 'ownership' } as const,
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

    alice.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
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

    expect(() => account.beginSourceImport({ format: 'pasted-list', text: 'x' })).toThrow(
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

  it('keeps every unresolved attempt of an account across a reload', async () => {
    const storage = memoryStorage();
    const client = scriptedClient({
      stageSourceImport: () => Promise.reject(unavailable()),
    });
    const first = createUserCardsOperations({
      client,
      storage,
      identity: identities(),
    }).account('alice');

    const begun = Array.from({ length: 40 }, (_, index) =>
      first.beginSourceImport({ format: 'pasted-list', text: `1 Lightning Bolt ${index}` }),
    );
    await Promise.all(begun.map((attempt) => attempt.observe()));
    expect(first.retained()).toHaveLength(begun.length);

    // A reload reattaches every unfinished attempt: none of them was silently evicted, so no
    // resubmission can create a second import while the first stays unresolved.
    const reloaded = createUserCardsOperations({
      client,
      storage,
      identity: identities(),
    }).account('alice');
    expect(reloaded.retained().map((attempt) => attempt.operationId)).toEqual(
      begun.map((attempt) => attempt.operationId),
    );
  });

  it('composes a fresh scope when an account signs back in', async () => {
    const requested: string[] = [];
    const client = scriptedClient({
      stageSourceImport: (input) => {
        requested.push(input.sessionId);
        return Promise.resolve(sourceResult(input.sessionId));
      },
    });
    const operations = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    });
    const alice = operations.account('alice');
    const lost = alice.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await lost.observe()).toMatchObject({ state: 'committed' });

    operations.release('alice');
    // The ended scope stays invalid for whoever still holds it.
    expect(() =>
      alice.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' }),
    ).toThrow(/has ended/);

    // Signing back in composes a fresh scope whose mutations work again.
    const again = operations.account('alice');
    expect(again).not.toBe(alice);
    const restored = again.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await restored.observe()).toMatchObject({ state: 'committed' });
    expect(restored.operationId).not.toBe(lost.operationId);
    expect(requested).toEqual([lost.operationId, restored.operationId]);
  });

  it('fences reads, subscriptions and outstanding handles of an ended account', async () => {
    const reads: string[] = [];
    const dispatches: string[] = [];
    const held = pendingCall<CopyChangeResult>();
    const client = scriptedClient({
      readCopies: async () => {
        reads.push('readCopies');
        return { privateRevision: 'revision-1', copies: new Map(), missing: [] };
      },
      correctCopy: () => {
        dispatches.push('correctCopy');
        return held.promise;
      },
    });
    const operations = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    });
    const alice = operations.account('alice');
    const change = alice.correctCopy({
      copyId: 'copy-1',
      expectedRevision: 1,
      printingId: 'printing-1',
      finish: 'foil',
      condition: null,
    });

    operations.release('alice');

    await expect(alice.readCopies(['copy-1'])).rejects.toThrow(/has ended/);
    expect(() => alice.subscribe(() => {})).toThrow(/has ended/);
    // The attempt that was still in flight keeps its open outcome and dispatches nothing: no
    // request of the ended account reaches the transport the replacement account serves.
    expect(await change.retry()).toEqual({ state: 'unknown', failure: null });
    expect(dispatches).toEqual(['correctCopy']);
    expect(reads).toEqual([]);
  });

  it('keeps an established outcome stable and never retries an unidentified creation', async () => {
    const calls: string[] = [];
    const client = scriptedClient({
      createTag: async () => {
        calls.push('createTag');
        return tag();
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');

    const committed = account.createTag({ kind: 'deck', label: 'Deck' });
    const established = await committed.observe();
    expect(established).toMatchObject({ state: 'committed' });
    // Retrying an established handle returns that outcome instead of composing a second tag.
    expect(await committed.retry()).toEqual(established);
    expect(calls).toEqual(['createTag']);

    // The provider composes a fresh tag identity per call, so an uncertain creation stays explicit
    // for the consumer's own reconciliation instead of dispatching again.
    let refused = false;
    const uncertain = createUserCardsOperations({
      client: scriptedClient({
        createTag: async () => {
          refused = true;
          throw unavailable();
        },
      }),
      storage: null,
      identity: identities(),
    }).account('alice');
    const lost = uncertain.createTag({ kind: 'deck', label: 'Deck' });
    expect(await lost.observe()).toMatchObject({ state: 'unknown' });
    expect(await lost.retry()).toMatchObject({ state: 'unknown' });
    expect(refused).toBe(true);

    // A change whose repeat quotes the revision it started from stays explicitly retryable.
    const revisions: number[] = [];
    const guarded = createUserCardsOperations({
      client: scriptedClient({
        correctCopy: async (input) => {
          revisions.push(input.expectedRevision);
          throw unavailable();
        },
      }),
      storage: null,
      identity: identities(),
    }).account('alice');
    const correction = guarded.correctCopy({
      copyId: 'copy-1',
      expectedRevision: 7,
      printingId: 'printing-1',
      finish: 'foil',
      condition: null,
    });
    expect(await correction.observe()).toMatchObject({ state: 'unknown' });
    await correction.retry();
    expect(revisions).toEqual([7, 7]);
  });

  it('coalesces a resubmission with the dispatch already in flight', async () => {
    const call = pendingCall<SourceImportResult>();
    let dispatched = 0;
    const changes: UserCardsChange[] = [];
    const client = scriptedClient({
      stageSourceImport: () => {
        dispatched += 1;
        return call.promise;
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    account.subscribe((change) => changes.push(change));

    const first = account.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    // A resubmission while the first dispatch is unresolved observes that dispatch; it never
    // dispatches a second request whose refusal could discard the authoritative result.
    const second = account.reopenSourceImport(first.operationId, {
      format: 'pasted-list',
      text: '1 Lightning Bolt',
    });
    call.resolve(sourceResult(first.operationId));

    expect(await first.observe()).toMatchObject({ state: 'committed' });
    expect(await second.observe()).toMatchObject({ state: 'committed' });
    expect(dispatched).toBe(1);
    expect(changes).toEqual([
      { scope: 'imports', records: [], imports: [first.operationId], position: null },
    ]);
  });

  it('refuses changed input under a retained staging identity', async () => {
    const staged: string[] = [];
    const client = scriptedClient({
      stageImportEntries: (input) => {
        staged.push(`${input.entries[0]?.entryId}:${input.entries[0]?.quantity}`);
        return Promise.reject(unavailable());
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    const source = { kind: 'manual', id: 'manual' } as const;
    const line = (quantity: number) => ({
      sessionId: 'manual',
      source,
      entries: [{ entryId: 'line-1', printingId: 'printing-1', quantity }],
    });

    const first = account.stageImportEntries(line(1));
    expect(await first.observe()).toMatchObject({ state: 'unknown' });

    // The identity was begun with quantity 1: presenting quantity 2 conflicts instead of reporting
    // the retained attempt's outcome for values the caller no longer presents.
    const changed = account.stageImportEntries(line(2));
    expect(await changed.observe()).toEqual({
      state: 'rejected',
      failure: {
        code: 'conflict',
        message:
          'An unfinished attempt retains this identity for different input. Retry it with its own ' +
          'values, or resolve it before submitting changed ones.',
      },
    });
    expect(staged).toEqual(['line-1:1']);
    expect(account.retained().map((attempt) => attempt.operationId)).toEqual([first.operationId]);
  });

  it('refuses confirmation input a retained identity did not review', async () => {
    const confirmations: number[] = [];
    const client = scriptedClient({
      confirmImport: (input) => {
        confirmations.push(input.entries[0]?.expectedRevision ?? 0);
        return Promise.reject(unavailable());
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');
    const confirmation = (expectedRevision: number) => ({
      destination: { kind: 'ownership' } as const,
      sessionId: 'import-1',
      entries: [{ entryId: 'entry-1', expectedRevision }],
    });

    const first = account.confirmImport(confirmation(1));
    expect(await first.observe()).toMatchObject({ state: 'unknown' });
    const reviewed = account.confirmImport(confirmation(2));
    expect(await reviewed.observe()).toMatchObject({
      state: 'rejected',
      failure: { code: 'conflict' },
    });
    expect(confirmations).toEqual([1]);
    expect(account.retained().map((attempt) => attempt.operationId)).toEqual([first.operationId]);
  });

  it('reopens an established import under the identity it is known by', async () => {
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

    // The consumer carries the identity of an import that already exists: reconciling its source
    // reads that import again instead of beginning another one.
    const reopened = account.reopenSourceImport('import-9', {
      format: 'moxfield',
      url: 'https://moxfield.com/decks/deck-9',
    });
    expect(await reopened.observe()).toMatchObject({ state: 'committed' });
    expect(requested).toEqual(['import-9']);

    // The acknowledged reconciliation has no unfinished attempt left to resume.
    expect(account.retained()).toEqual([]);
  });

  it('recovers a confirmation through the dispatch still in flight', async () => {
    const call = pendingCall<ImportConfirmationResult>();
    let recordedReads = 0;
    const client = scriptedClient({
      confirmImport: () => call.promise,
      recoverImportOperation: async () => {
        recordedReads += 1;
        return { outcome: 'absent' };
      },
    });
    const account = createUserCardsOperations({
      client,
      storage: null,
      identity: identities(),
    }).account('alice');

    const confirmation = account.confirmImport({
      destination: { kind: 'ownership' } as const,
      sessionId: 'import-1',
      entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
    });
    // The explicit recovery observes the confirmation already in flight: a recorded read issued
    // now could answer for a state that predates the commit.
    const recovered = confirmation.recover();
    call.resolve({
      privateRevision: 'revision-2',
      replayed: false,
      operationId: confirmation.operationId,
      sessionId: 'import-1',
      sourceKind: 'pasted-list',
      sourceId: 'import-1',
      destination: { kind: 'ownership' },
      publicationPosition: '5',
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-1',
          finish: 'nonfoil',
          condition: null,
          revision: 1,
        },
      ],
      associations: [],
    });

    const observed = await confirmation.observe();
    expect(observed).toMatchObject({
      state: 'committed',
      record: { operationId: confirmation.operationId, replayed: false },
    });
    expect(await recovered).toEqual(observed);
    expect(recordedReads).toBe(0);
  });
});
