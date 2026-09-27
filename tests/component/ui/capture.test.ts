/**
 * Component scope: hands-free camera capture of the UserInterface
 * (docs/user-interface.md#capture-and-review, docs/recognition.md#interface,
 * docs/user-cards.md#import-and-capture-state).
 *
 * The admission and feedback policy, the mapping of one Recognition reading into the observation
 * UserCards stages and the private operations the capture reads through are asserted here; the
 * Import page itself is exercised as observable browser behavior in tests/browser/capture.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../../../src/application/index.js';
import type { RecognitionCandidate, RecognitionReading } from '../../../src/recognition/index.js';
import type {
  CaptureStageResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportSession,
  StageCaptureInput,
} from '../../../src/usercards/index.js';
import {
  attachImportCandidates,
  createImportAccess,
  stageCaptureObservation,
  uiCaptureIdentity,
  type UiImportAccess,
  type UiImportClient,
} from '../../../src/ui/index.js';
import {
  createCaptureAdmission,
  frameDifference,
} from '../../../src/ui/internal/capture-admission.js';
import { uiCaptureCandidates, uiCaptureObservation } from '../../../src/ui/internal/capture.js';

const still = [120, 120, 120, 120];
const moved = [10, 10, 10, 10];

function candidate(overrides: Partial<RecognitionCandidate> = {}): RecognitionCandidate {
  return {
    cardId: 'card-1',
    printingId: 'printing-1',
    name: 'Lightning Bolt',
    score: null,
    ...overrides,
  };
}

function reading(overrides: Partial<RecognitionReading> = {}): RecognitionReading {
  return {
    identity: { sessionId: 'session-1', captureId: 'capture-1', attempt: 1 },
    revision: 1,
    status: 'possible',
    candidates: [candidate()],
    suggestion: { candidateIndex: 0, printingId: 'printing-1', basis: 'representative' },
    evidence: {
      printingId: null,
      titleLanguage: null,
      titleCorroborated: false,
      cardPresence: 'single',
    },
    provisional: false,
    disagreement: null,
    versions: {},
    timings: {},
    ...overrides,
  };
}

function session(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    sessionId: 'ui-capture-1',
    sourceKind: 'capture',
    sourceId: 'ui-capture-1',
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
    entryId: 'capture-1',
    sessionId: 'ui-capture-1',
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

function captureStage(outcome: CaptureStageResult['outcome']): CaptureStageResult {
  return {
    privateRevision: 'private-2',
    outcome,
    replayed: false,
    session: session(),
    entry: outcome === 'admitted' ? entry() : null,
  };
}

function changedEntry(): ImportEntryChangeResult {
  return { privateRevision: 'private-3', session: session({ revision: 2 }), entry: entry() };
}

const observation: StageCaptureInput = {
  sessionId: 'ui-capture-1',
  captureId: 'capture-1',
  printingId: 'printing-1',
};

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

describe('capture admission', () => {
  it('compares sampled frames by their brightness, never by identity', () => {
    expect(frameDifference(still, still)).toBe(0);
    expect(frameDifference(still, moved)).toBe(110);
    expect(frameDifference(still, [120, 120])).toBe(Number.POSITIVE_INFINITY);
  });

  it('admits an attempt only from a frame that has settled', () => {
    const admission = createCaptureAdmission({ settleMs: 600 });
    admission.observe(still, 0);
    expect(admission.ready(300)).toBe(false);
    expect(admission.ready(600)).toBe(true);

    admission.observe(moved, 700);
    expect(admission.ready(1250)).toBe(false);
    expect(admission.ready(1300)).toBe(true);
  });

  it('runs one attempt at a time and makes a new scene due without waiting out the retry', () => {
    const admission = createCaptureAdmission();
    admission.observe(still, 0);
    admission.observe(still, 600);
    admission.started(600);
    expect(admission.ready(700)).toBe(false);

    admission.settled(1, 'accepted', 700);
    expect(admission.ready(1200)).toBe(false);
    expect(admission.ready(1700)).toBe(true);

    admission.started(1700);
    admission.settled(1, 'accepted', 1800);
    admission.observe(moved, 1900);
    admission.observe(moved, 2400);
    expect(admission.ready(2500)).toBe(true);
  });

  it('cues an attempt once, and only an admitted capture is a success', () => {
    const admission = createCaptureAdmission();
    admission.started(0);
    expect(admission.settled(1, 'unresolved', 100)).toBe('error');
    expect(admission.settled(1, 'unresolved', 200)).toBeNull();
    expect(admission.settled(1, 'accepted', 300)).toBe('accepted');
    expect(admission.settled(1, 'accepted', 400)).toBeNull();
    expect(admission.settled(1, 'repeat', 500)).toBe('repeat');
    expect(admission.settled(1, 'guidance', 600)).toBeNull();
    expect(admission.settled(2, 'unavailable', 700)).toBe('error');
    expect(admission.settled(2, 'unavailable', 800)).toBeNull();
  });
});

describe('capture observation', () => {
  it('stages the suggested printing with its alternatives, keeping evidence labels', () => {
    const observed = reading({
      candidates: [
        candidate({ printingId: 'printing-2', name: 'Bolt' }),
        candidate({ printingId: 'printing-1' }),
      ],
      suggestion: { candidateIndex: 0, printingId: 'printing-2', basis: 'corroborated' },
      evidence: {
        printingId: 'printing-2',
        titleLanguage: 'en',
        titleCorroborated: true,
        cardPresence: 'single',
      },
    });

    expect(uiCaptureObservation('session-1', 'capture-1', observed)).toEqual({
      sessionId: 'session-1',
      captureId: 'capture-1',
      printingId: 'printing-2',
      finish: null,
      candidates: [
        { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
        { printingId: 'printing-1', provider: 'recognition', evidence: 'engine-ranking' },
      ],
    });
    expect(uiCaptureCandidates(reading())).toEqual([
      { printingId: 'printing-1', provider: 'recognition', evidence: 'engine-ranking' },
    ]);
  });

  it('stages nothing for a reading without a usable identity', () => {
    const unknown = reading({ status: 'unknown', candidates: [], suggestion: null });
    expect(uiCaptureObservation('session-1', 'capture-1', unknown)).toBeNull();
    expect(uiCaptureCandidates(unknown)).toEqual([]);
  });

  it('generates bounded, unique identities for capture sessions and attempts', () => {
    const first = uiCaptureIdentity();
    const second = uiCaptureIdentity();
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(200);
  });
});

describe('capture staging', () => {
  it('reports an admitted capture as an entry in review, never as ownership', async () => {
    const outcome = await stageCaptureObservation(
      access({ capture: async () => captureStage('admitted') }),
      observation,
    );

    expect(outcome).toMatchObject({
      status: 'committed',
      message: null,
      record: { outcome: 'admitted', entry: { state: 'pending' } },
    });
  });

  it('reports a suppressed repeat without adding an entry', async () => {
    const outcome = await stageCaptureObservation(
      access({ capture: async () => captureStage('suppressed') }),
      observation,
    );

    expect(outcome).toMatchObject({ status: 'committed', record: { entry: null } });
  });

  it('keeps the capture identity for a retry when the outcome is unknown', async () => {
    const outcome = await stageCaptureObservation(
      access({ capture: () => Promise.reject(new ApplicationError('busy', 'Try again.')) }),
      observation,
    );

    expect(outcome.status).toBe('unknown');
    expect(outcome.record).toBeNull();
    expect(outcome.message).toContain('may be in review');
  });

  it('reports a capture already staged with different content as a conflict', async () => {
    const outcome = await stageCaptureObservation(
      access({ capture: () => Promise.reject(new ApplicationError('conflict', 'Reload.')) }),
      observation,
    );

    expect(outcome).toMatchObject({ status: 'conflict', message: 'Reload.' });
  });

  it('attaches late alternatives without changing the reviewed values', async () => {
    const attach = vi.fn(async () => changedEntry());
    const outcome = await attachImportCandidates(access({ attach }), {
      entryId: 'capture-1',
      candidates: [
        { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
      ],
    });

    expect(outcome).toMatchObject({ status: 'committed', record: { entry: entry() } });
    expect(attach).toHaveBeenCalledWith(
      {
        entryId: 'capture-1',
        candidates: [
          { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
        ],
      },
      undefined,
    );
  });

  it('reads the capture operations through the private contract', async () => {
    const stageCaptureObservationCall = vi.fn(async () => captureStage('admitted'));
    const attachImportCandidatesCall = vi.fn(async () => changedEntry());
    const built = createImportAccess(
      client({
        stageCaptureObservation: stageCaptureObservationCall,
        attachImportCandidates: attachImportCandidatesCall,
      }),
    );

    await expect(built.capture(observation)).resolves.toMatchObject({ outcome: 'admitted' });
    await expect(built.attach({ entryId: 'capture-1', candidates: [] })).resolves.toMatchObject({
      entry: entry(),
    });
    expect(stageCaptureObservationCall).toHaveBeenCalledWith(observation, undefined);
    expect(attachImportCandidatesCall).toHaveBeenCalledWith(
      { entryId: 'capture-1', candidates: [] },
      undefined,
    );
  });

  it('requires the capture operations the Import page stages through', () => {
    expect(() =>
      createImportAccess({
        ...client(),
        stageCaptureObservation: undefined,
      } as unknown as UiImportClient),
    ).toThrow(TypeError);
    expect(() =>
      createImportAccess({
        ...client(),
        attachImportCandidates: undefined,
      } as unknown as UiImportClient),
    ).toThrow(TypeError);
  });
});
