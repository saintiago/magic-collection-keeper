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
  stageImportLines,
  uiImportCandidates,
  uiImportIdentity,
  uiImportSourceLabel,
  type UiImportAccess,
  type UiImportClient,
} from '../../../src/ui/index.js';

function entry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'entry-1',
    sessionId: 'manual',
    position: 1,
    state: 'pending',
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

/** One access whose operations the case scripts; unscripted calls fail loudly. */
function access(overrides: Partial<UiImportAccess> = {}): UiImportAccess {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
  return {
    sessions: unused,
    entries: unused,
    stage: unused,
    capture: unused,
    review: unused,
    attach: unused,
    discardEntry: unused,
    discardSession: unused,
    confirm: unused,
    recover: unused,
    ...overrides,
  };
}

/** One private client whose operations the case scripts; unscripted calls fail loudly. */
function client(overrides: Partial<UiImportClient> = {}): UiImportClient {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
  return {
    listImportSessions: unused,
    listImportEntries: unused,
    stageImportEntries: unused,
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
    const built = createImportAccess(client({ listImportSessions, listImportEntries }));

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
    expect(() => createImportAccess({} as unknown as UiImportClient)).toThrow(TypeError);
    expect(() =>
      createImportAccess({
        listImportSessions: () => Promise.reject(new Error('no')),
      } as unknown as UiImportClient),
    ).toThrow(TypeError);
  });
});

describe('import staging', () => {
  it('reports committed lines as entries in review, never as ownership', async () => {
    const outcome = await stageImportLines(access({ stage: async () => staged() }), {
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
        stage: () => Promise.reject(new ApplicationError('busy', 'Try again.')),
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
        stage: () => Promise.reject(new ApplicationError('conflict', 'Reload the import.')),
      }),
      {
        sessionId: 'manual',
        source: { kind: 'manual', id: 'manual' },
        entries: [{ entryId: 'entry-1', printingId: 'printing-1', quantity: 1 }],
      },
    );

    expect(outcome).toMatchObject({ status: 'conflict', message: 'Reload the import.' });
  });
});

describe('import review and discard', () => {
  it('reports the committed entry of a saved review', async () => {
    const outcome = await reviewImportEntry(access({ review: async () => changed() }), {
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
        review: () =>
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
    const removed = await discardImportEntry(access({ discardEntry: async () => changed() }), {
      entryId: 'entry-1',
      expectedRevision: 3,
    });
    const discarded = await discardImportSession(
      access({
        discardSession: async () => ({
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
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-m11-149-en',
          finish: 'nonfoil' as const,
          condition: null,
          revision: 1,
        },
      ],
      replayed: false,
      privateRevision: 'r5',
    };
    const outcome = await confirmImport(access({ confirm: async () => receipt }), {
      operationId: 'operation-1',
      sessionId: 'manual',
      entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
    });

    expect(outcome.status).toBe('committed');
    expect(outcome.record?.copies.map((copy) => copy.copyId)).toEqual(['copy-1']);
  });

  it('recovers the recorded outcome of a lost confirmation response', async () => {
    const outcome = await confirmImport(
      access({
        confirm: () => Promise.reject(new ApplicationError('busy', 'Try again.')),
        recover: async () => ({
          outcome: 'recorded',
          receipt: {
            operationId: 'operation-1',
            sessionId: 'manual',
            sourceKind: 'manual',
            sourceId: 'manual',
            copies: [
              {
                copyId: 'copy-1',
                printingId: 'printing-m11-149-en',
                finish: 'nonfoil',
                condition: null,
                revision: 1,
              },
            ],
          },
        }),
      }),
      {
        operationId: 'operation-1',
        sessionId: 'manual',
        entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
      },
    );

    expect(outcome.status).toBe('committed');
    expect(outcome.record?.copies).toHaveLength(1);
    expect(outcome.message).toContain('already been recorded');
  });

  it('reports an explicit absence as a confirmation that created no copies', async () => {
    const outcome = await confirmImport(
      access({
        confirm: () => Promise.reject(new ApplicationError('unavailable', 'Lost.')),
        recover: async () => ({ outcome: 'absent' }),
      }),
      {
        operationId: 'operation-1',
        sessionId: 'manual',
        entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
      },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.record).toBeNull();
    expect(outcome.message).toContain('not recorded');
  });

  it('keeps the confirmation unknown when its recovery cannot be read', async () => {
    const outcome = await confirmImport(
      access({
        confirm: () => Promise.reject(new ApplicationError('busy', 'Lost.')),
        recover: () => Promise.reject(new ApplicationError('unavailable', 'Offline.')),
      }),
      {
        operationId: 'operation-1',
        sessionId: 'manual',
        entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
      },
    );

    expect(outcome).toMatchObject({ status: 'unknown', record: null });
    expect(outcome.message).toContain('could not be read');
  });

  it('reports a confirmation refused before it could commit as a definite failure', async () => {
    const recover = vi.fn(async () => ({ outcome: 'absent' as const }));
    const outcome = await confirmImport(
      access({
        confirm: () => Promise.reject(new ApplicationError('invalid-request', 'Bad input.')),
        recover,
      }),
      {
        operationId: 'operation-1',
        sessionId: 'manual',
        entries: [{ entryId: 'entry-1', expectedRevision: 3 }],
      },
    );

    expect(outcome).toMatchObject({ status: 'failed', message: 'Bad input.' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('reads the recorded outcome of one confirmation independently of its entries', async () => {
    const receipt = {
      operationId: 'operation-1',
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-m11-149-en',
          finish: 'nonfoil' as const,
          condition: null,
          revision: 1,
        },
      ],
    };
    const recorded = await recoverConfirmation(
      access({ recover: async () => ({ outcome: 'recorded', receipt }) }),
      'operation-1',
    );
    const absent = await recoverConfirmation(
      access({ recover: async () => ({ outcome: 'absent' }) }),
      'operation-1',
    );
    const unreadable = await recoverConfirmation(
      access({ recover: () => Promise.reject(new Error('Offline.')) }),
      'operation-1',
    );

    expect(recorded).toMatchObject({ status: 'committed', record: { copies: receipt.copies } });
    expect(recorded.message).toContain('already been recorded');
    expect(absent).toMatchObject({ status: 'failed', record: null });
    expect(absent.message).toContain('not recorded');
    expect(unreadable).toMatchObject({ status: 'unknown', record: null });
    expect(unreadable.message).toContain('could not be read');
  });
});
