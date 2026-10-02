/**
 * Component scope: the import boundary of the UserInterface
 * (docs/user-interface.md#capture-and-review, docs/user-cards.md#import-and-capture-state).
 *
 * The private access the Import page builds over the UserCards contract, the outcome of staging a
 * manual line, of reviewing and discarding a pending entry and of a confirmation whose response was
 * lost are asserted here; the page itself is exercised as observable browser behavior in
 * tests/browser/import.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../../../src/application/index.js';
import {
  createUserCardsOperations,
  type UserCardsConfirmationOutcome,
  type UserCardsOperation,
  type UserCardsBrowserClient,
} from '../../../src/usercards/browser.js';
import type {
  ImportEntry,
  ImportEntryChangeResult,
  ImportSession,
  ImportStageResult,
} from '../../../src/usercards/index.js';
import {
  confirmImport,
  createImportAccess,
  discardImportEntry,
  discardImportSession,
  recoverConfirmation,
  reviewImportEntry,
  beginSourceImport,
  stageImportLines,
  uiImportCandidates,
  uiImportIdentity,
  uiImportSourceLabel,
  type UiImportAccess,
} from '../../../src/ui/index.js';

function entry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'entry-1',
    sessionId: 'manual',
    position: 1,
    state: 'pending',
    cardId: 'card-m11-149',
    printingId: 'printing-m11-149-en',
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [],
    sourceLine: null,
    revision: 3,
    ...overrides,
  };
}

function session(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    sourceReference: null,
    state: 'pending',
    pendingEntries: 1,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 4,
    ...overrides,
  };
}

function staged(): ImportStageResult {
  return {
    privateRevision: 'r2',
    session: session(),
    entries: [entry()],
    staged: 1,
    replayed: false,
  };
}

function changed(): ImportEntryChangeResult {
  return { privateRevision: 'r3', session: session({ revision: 5 }), entry: entry() };
}

/** One private client whose operations the case scripts; unscripted calls fail loudly. */
function client(overrides: Partial<UserCardsBrowserClient> = {}): UserCardsBrowserClient {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
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
    ...overrides,
  };
}

/**
 * The Import page's private access over the provider-owned browser facade: the case scripts the
 * transport-backed client, and the facade owns the operation lifecycle the page presents.
 */
function access(overrides: Partial<UserCardsBrowserClient> = {}): UiImportAccess {
  return createImportAccess(
    createUserCardsOperations({ client: client(overrides), storage: null }).account('alice'),
  );
}

describe('import vocabulary', () => {
  it('names the acquisition sources the Import page presents', () => {
    expect(uiImportSourceLabel('manual')).toBe('Manual entry');
    expect(uiImportSourceLabel('capture')).toBe('Camera capture');
    expect(uiImportSourceLabel('pasted-list')).toBe('Pasted list');
    expect(uiImportSourceLabel('moxfield')).toBe('Moxfield deck');
    expect(uiImportSourceLabel('wizards-precon')).toBe('Wizards preconstructed deck');
    expect(uiImportSourceLabel('other')).toBe('Import');
  });

  it('presents the stored recognition alternatives of one entry', () => {
    expect(
      uiImportCandidates(
        entry({
          printingId: null,
          finish: null,
          candidates: [{ printingId: 'printing-1', provider: 'visual', evidence: 'art-match' }],
        }),
      ),
    ).toEqual([{ printingId: 'printing-1', provider: 'visual', evidence: 'art-match' }]);
  });

  it('generates bounded, unique identities for staged lines and operations', () => {
    const first = uiImportIdentity();
    const second = uiImportIdentity();
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(200);
    expect(second.length).toBeLessThanOrEqual(200);
  });
});

describe('import access', () => {
  it('reads and changes pending imports through the UserCards contract', async () => {
    const listImportSessions = vi.fn(async () => ({
      privateRevision: 'r1',
      sessions: [session()],
      continuation: null,
    }));
    const listImportEntries = vi.fn(async () => ({
      privateRevision: 'r1',
      session: session(),
      entries: [entry()],
      continuation: null,
    }));
    const built = access({ listImportSessions, listImportEntries });

    await expect(built.sessions({ pageSize: 2 })).resolves.toMatchObject({
      sessions: [session()],
    });
    await expect(built.entries({ sessionId: 'manual' })).resolves.toMatchObject({
      entries: [entry()],
    });
    expect(listImportSessions).toHaveBeenCalledWith({ pageSize: 2 }, undefined);
    expect(listImportEntries).toHaveBeenCalledWith({ sessionId: 'manual' }, undefined);
  });

  it('requires every operation the Import page presents', () => {
    expect(() => createImportAccess({} as never)).toThrow(TypeError);
    expect(() =>
      createImportAccess({
        listImportSessions: () => Promise.reject(new Error('no')),
      } as never),
    ).toThrow(TypeError);
  });
});

describe('import staging', () => {
  it('reports committed lines as entries in review, never as ownership', async () => {
    const outcome = await stageImportLines(access({ stageImportEntries: async () => staged() }), {
      sessionId: 'manual',
      source: { kind: 'manual', id: 'manual' },
      entries: [{ entryId: 'entry-1', printingId: 'printing-1', quantity: 1 }],
    });

    expect(outcome).toMatchObject({ status: 'committed', record: { staged: 1 } });
    expect(outcome.message).toBeNull();
  });

  it('keeps a line for an idempotent retry when the staging outcome is unknown', async () => {
    const outcome = await stageImportLines(
      access({
        stageImportEntries: () => Promise.reject(new ApplicationError('busy', 'Try again.')),
      }),
      {
        sessionId: 'manual',
        source: { kind: 'manual', id: 'manual' },
        entries: [{ entryId: 'entry-1', printingId: 'printing-1', quantity: 1 }],
      },
    );

    expect(outcome.status).toBe('unknown');
    expect(outcome.record).toBeNull();
    expect(outcome.message).toContain('may be in review');
  });

  it('reports a line already staged with different content as a conflict', async () => {
    const outcome = await stageImportLines(
      access({
        stageImportEntries: () =>
          Promise.reject(new ApplicationError('conflict', 'Reload the import.')),
      }),
      {
        sessionId: 'manual',
        source: { kind: 'manual', id: 'manual' },
        entries: [{ entryId: 'entry-1', printingId: 'printing-1', quantity: 1 }],
      },
    );

    expect(outcome).toMatchObject({ status: 'conflict', message: 'Reload the import.' });
  });

  it('stages a parsed source and reports what every row became', async () => {
    const outcome = await beginSourceImport(
      access({
        stageSourceImport: async () => ({
          privateRevision: 'r2',
          session: session({
            sessionId: 'pasted-list',
            sourceKind: 'pasted-list',
            sourceId: 'pasted-list',
          }),
          rows: [
            {
              position: 1,
              line: null,
              outcome: 'invalid',
              problem: 'Use “quantity card name”, optionally followed by “(SET) number”.',
              entryId: null,
              sessionId: null,
            },
          ],
          staged: 0,
        }),
      }),
      { format: 'pasted-list', text: 'not a line' },
    );

    expect(outcome).toMatchObject({
      status: 'committed',
      record: { staged: 0, rows: [{ outcome: 'invalid' }] },
    });
  });

  it('keeps an unreported source recoverable by reopening its import', async () => {
    const outcome = await beginSourceImport(
      access({
        stageSourceImport: () => Promise.reject(new ApplicationError('busy', 'Try again.')),
      }),
      {
        format: 'moxfield',
        url: 'https://moxfield.com/decks/deck-1',
      },
    );

    expect(outcome.status).toBe('unknown');
    expect(outcome.record).toBeNull();
    expect(outcome.message).toContain('Reopen the waiting import');
  });

  it('reports a source the provider refused as a definite failure', async () => {
    const outcome = await beginSourceImport(
      access({
        stageSourceImport: () =>
          Promise.reject(new ApplicationError('invalid-request', 'Enter a public deck link.')),
      }),
      { format: 'moxfield', url: 'https://example.test/deck' },
    );

    expect(outcome).toMatchObject({
      status: 'failed',
      message: 'Enter a public deck link.',
      record: null,
    });
  });
});

describe('import review and discard', () => {
  it('reports the committed entry of a saved review', async () => {
    const outcome = await reviewImportEntry(access({ reviewImportEntry: async () => changed() }), {
      entryId: 'entry-1',
      expectedRevision: 3,
      printingId: 'printing-m11-149-en',
      finish: 'foil',
      condition: null,
      quantity: 2,
    });

    expect(outcome).toMatchObject({ status: 'committed', record: { entry: entry() } });
  });

  it('reports a stale reviewed revision as a conflict that keeps the input', async () => {
    const outcome = await reviewImportEntry(
      access({
        reviewImportEntry: () =>
          Promise.reject(new ApplicationError('conflict', 'The entry changed; reload it.')),
      }),
      {
        entryId: 'entry-1',
        expectedRevision: 3,
        printingId: 'printing-m11-149-en',
        finish: 'foil',
        condition: null,
        quantity: 1,
      },
    );

    expect(outcome).toMatchObject({ status: 'conflict', message: 'The entry changed; reload it.' });
  });

  it('discards one entry and one import without creating copies', async () => {
    const removed = await discardImportEntry(
      access({ discardImportEntry: async () => changed() }),
      {
        entryId: 'entry-1',
        expectedRevision: 3,
      },
    );
    const discarded = await discardImportSession(
      access({
        discardImportSession: async () => ({
          privateRevision: 'r4',
          session: session({ state: 'discarded' }),
        }),
      }),
      { sessionId: 'manual', expectedRevision: 4 },
    );

    expect(removed.status).toBe('committed');
    expect(discarded).toMatchObject({
      status: 'committed',
      record: { session: { state: 'discarded' } },
    });
  });
});

describe('import confirmation', () => {
  it('presents the receipt of a committed confirmation', async () => {
    const receipt = {
      operationId: 'operation-1',
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      destination: { kind: 'ownership' } as const,
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-m11-149-en',
          finish: 'nonfoil' as const,
          condition: null,
          revision: 1,
        },
      ],
      associations: [],
      replayed: false,
      privateRevision: 'r5',
    };
    const operation = access({ confirmImport: async () => receipt }).confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    const outcome = await confirmImport(operation);

    expect(outcome.status).toBe('committed');
    expect(outcome.record?.copies.map((copy) => copy.copyId)).toEqual(['copy-1']);
  });

  it('recovers the recorded outcome of a lost confirmation response', async () => {
    const operation = access({
      confirmImport: () => Promise.reject(new ApplicationError('busy', 'Try again.')),
      recoverImportOperation: async () => ({
        outcome: 'recorded',
        receipt: {
          operationId: 'operation-1',
          sessionId: 'manual',
          sourceKind: 'manual',
          sourceId: 'manual',
          destination: { kind: 'ownership' } as const,

          copies: [
            {
              copyId: 'copy-1',
              printingId: 'printing-m11-149-en',
              finish: 'nonfoil',
              condition: null,
              revision: 1,
            },
          ],
          associations: [],
        },
      }),
    }).confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    const outcome = await confirmImport(operation);

    expect(outcome.status).toBe('committed');
    expect(outcome.record?.copies).toHaveLength(1);
    expect(outcome.message).toContain('already been recorded');
  });

  it('reports an explicit absence as a confirmation that created no copies', async () => {
    const operation = access({
      confirmImport: () => Promise.reject(new ApplicationError('unavailable', 'Lost.')),
      recoverImportOperation: async () => ({ outcome: 'absent' }),
    }).confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    const outcome = await confirmImport(operation);

    expect(outcome.status).toBe('failed');
    expect(outcome.record).toBeNull();
    expect(outcome.message).toContain('not recorded');
  });

  it('keeps the confirmation unknown when its recovery cannot be read', async () => {
    const operation = access({
      confirmImport: () => Promise.reject(new ApplicationError('busy', 'Lost.')),
      recoverImportOperation: () => Promise.reject(new ApplicationError('unavailable', 'Offline.')),
    }).confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    const outcome = await confirmImport(operation);

    expect(outcome).toMatchObject({ status: 'unknown', record: null });
    expect(outcome.message).toContain('could not be read');
  });

  it('reports a confirmation refused before it could commit as a definite failure', async () => {
    const recover = vi.fn(async () => ({ outcome: 'absent' as const }));
    const operation = access({
      confirmImport: () => Promise.reject(new ApplicationError('invalid-request', 'Bad input.')),
      recoverImportOperation: recover,
    }).confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    const outcome = await confirmImport(operation);

    expect(outcome).toMatchObject({ status: 'failed', message: 'Bad input.' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('reads the recorded outcome of one confirmation independently of its entries', async () => {
    const receipt = {
      operationId: 'operation-1',
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      destination: { kind: 'ownership' } as const,

      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-m11-149-en',
          finish: 'nonfoil' as const,
          condition: null,
          revision: 1,
        },
      ],
      associations: [],
    };
    const recorded = await recoverConfirmation(
      retainedConfirmation(
        access({ recoverImportOperation: async () => ({ outcome: 'recorded', receipt }) }),
      ),
    );
    const absent = await recoverConfirmation(
      retainedConfirmation(access({ recoverImportOperation: async () => ({ outcome: 'absent' }) })),
    );
    const unreadable = await recoverConfirmation(
      retainedConfirmation(
        access({ recoverImportOperation: () => Promise.reject(new Error('Offline.')) }),
      ),
    );

    expect(recorded).toMatchObject({ status: 'committed', record: { copies: receipt.copies } });
    expect(recorded.message).toContain('already been recorded');
    expect(absent).toMatchObject({ status: 'failed', record: null });
    expect(absent.message).toContain('not recorded');
    expect(unreadable).toMatchObject({ status: 'unknown', record: null });
    expect(unreadable.message).toContain('could not be read');
  });

  /**
   * One unfinished confirmation of the account: its response is lost, so the attempt stays
   * recoverable through the identity UserCards owns.
   */
  function retainedConfirmation(
    access: UiImportAccess,
  ): UserCardsOperation<'confirmImport', UserCardsConfirmationOutcome> {
    const operation = access.confirm({
      destination: { kind: 'ownership' } as const,
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });
    return operation;
  }
});
