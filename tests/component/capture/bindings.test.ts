/**
 * Component scope: the Capture bindings and frame scheduler (docs/capture.md#internal-design,
 * docs/recognition.md#interface, docs/user-cards.md#browser-operation-lifecycle).
 *
 * The mapping of one Recognition reading into the observation UserCards stages, the translation of
 * the provider-owned operation handles into Capture's staging protocol, the browser device
 * lifecycle and the sampling policy are asserted here; the session built on them is exercised in
 * tests/component/capture/capture.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { ApplicationError } from '../../../src/application/index.js';
import {
  CAPTURE_LIMITS,
  captureObservation,
  captureReading,
  captureStaging,
  createBrowserCaptureDevice,
  createCaptureAdmission,
  createCaptureBrowser,
  frameDifference,
  type CaptureBrowserDevice,
  type CaptureSnapshot,
  type CaptureVideoSurface,
} from '../../../src/capture/index.js';
import {
  recognitionEngineNames,
  type RecognitionCandidate,
  type RecognitionReading,
} from '../../../src/recognition/index.js';
import {
  createUserCardsOperations,
  type UserCardsBrowserClient,
} from '../../../src/usercards/browser.js';
import type {
  CaptureStageResult,
  ImportEntry,
  ImportSession,
  StageCaptureInput,
} from '../../../src/usercards/index.js';

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
    identity: { sessionId: 'import-1', captureId: 'capture-1', attempt: 1 },
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

function session(): ImportSession {
  return {
    sessionId: 'import-1',
    sourceKind: 'capture',
    sourceId: 'import-1',
    sourceReference: null,
    state: 'pending',
    pendingEntries: 1,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 2,
  };
}

function entry(): ImportEntry {
  return {
    entryId: 'capture-1',
    sessionId: 'import-1',
    position: 1,
    state: 'pending',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [],
    sourceLine: null,
    revision: 3,
  };
}

function unused(): Promise<never> {
  return Promise.reject(new Error('The case did not script this private operation.'));
}

function client(overrides: Partial<UserCardsBrowserClient> = {}): UserCardsBrowserClient {
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

describe('capture readings', () => {
  it('marks the printing the evidence corroborated and never the others', () => {
    const observed = reading({
      candidates: [
        candidate({ printingId: 'printing-1' }),
        candidate({ printingId: 'printing-2', cardId: 'card-2', name: 'Sol Ring' }),
      ],
      evidence: {
        printingId: 'printing-2',
        titleLanguage: 'en',
        titleCorroborated: true,
        cardPresence: 'single',
      },
      suggestion: { candidateIndex: 0, printingId: 'printing-1', basis: 'representative' },
      disagreement: { cardIds: ['card-1', 'card-2'] },
      provisional: true,
    });

    expect(captureReading(observed)).toEqual({
      captureId: 'capture-1',
      attempt: 1,
      revision: 1,
      status: 'possible',
      candidates: [
        {
          cardId: 'card-1',
          printingId: 'printing-1',
          name: 'Lightning Bolt',
          evidence: 'engine-ranking',
        },
        {
          cardId: 'card-2',
          printingId: 'printing-2',
          name: 'Sol Ring',
          evidence: 'title-evidence',
        },
      ],
      suggestedPrintingId: 'printing-1',
      presence: 'single',
      provisional: true,
      uncertain: true,
    });
  });

  it('stages the suggested printing with the reading alternatives beside it', () => {
    const observation = captureObservation(
      'import-1',
      'capture-1',
      reading({
        candidates: [
          candidate({ printingId: 'printing-1' }),
          candidate({ printingId: 'printing-2' }),
        ],
        suggestion: { candidateIndex: 1, printingId: 'printing-2', basis: 'corroborated' },
        evidence: {
          printingId: 'printing-2',
          titleLanguage: 'en',
          titleCorroborated: true,
          cardPresence: 'single',
        },
      }),
    );

    expect(observation).toEqual({
      sessionId: 'import-1',
      captureId: 'capture-1',
      printingId: 'printing-2',
      finish: null,
      candidates: [
        { printingId: 'printing-1', provider: 'recognition', evidence: 'engine-ranking' },
        { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
      ],
    });
  });

  it('stages no observation for a reading without a usable identity', () => {
    expect(
      captureObservation(
        'import-1',
        'capture-1',
        reading({ status: 'unknown', candidates: [], suggestion: null }),
      ),
    ).toBeNull();
  });
});

describe('capture staging binding', () => {
  it('reads the provider outcome without inferring commitment from a failure', async () => {
    const operations = createUserCardsOperations({
      storage: null,
      client: client({
        stageCaptureObservation: () =>
          Promise.reject(new ApplicationError('unavailable', 'The service is unavailable.')),
      }),
    });
    const staging = captureStaging(operations.account('alice'));

    const outcome = await staging
      .stage({ sessionId: 'import-1', captureId: 'capture-1', printingId: 'printing-1' })
      .observe();

    expect(outcome).toEqual({ state: 'unknown' });
    expect(operations.account('alice').retained()).toHaveLength(1);
  });

  it('keeps a rejected staging attempt out of the recoverable state', async () => {
    const operations = createUserCardsOperations({
      storage: null,
      client: client({
        stageCaptureObservation: () =>
          Promise.reject(new ApplicationError('invalid-request', 'The capture was refused.')),
      }),
    });
    const staging = captureStaging(operations.account('alice'));

    const outcome = await staging
      .stage({ sessionId: 'import-1', captureId: 'capture-1', printingId: 'printing-1' })
      .observe();

    expect(outcome).toEqual({ state: 'rejected', message: 'The capture was refused.' });
    expect(operations.account('alice').retained()).toEqual([]);
  });

  it('replays a retained attempt through its own identity and input', async () => {
    const inputs: StageCaptureInput[] = [];
    let answer = 0;
    const operations = createUserCardsOperations({
      storage: null,
      client: client({
        stageCaptureObservation: (input) => {
          inputs.push(input);
          answer += 1;
          if (answer === 1) {
            return Promise.reject(new ApplicationError('unavailable', 'Response lost.'));
          }
          const result: CaptureStageResult = {
            privateRevision: 'private-2',
            outcome: 'admitted',
            replayed: true,
            session: session(),
            entry: entry(),
          };
          return Promise.resolve(result);
        },
      }),
    });
    const staging = captureStaging(operations.account('alice'));
    const observation: StageCaptureInput = {
      sessionId: 'import-1',
      captureId: 'capture-1',
      printingId: 'printing-1',
    };
    await staging.stage(observation).observe();

    const retained = staging.retained();
    expect(retained).toEqual([{ captureId: 'capture-1', input: observation }]);
    const resumed = staging.resume('capture-1');
    expect(resumed?.input).toEqual(observation);
    await expect(resumed?.observe()).resolves.toEqual({
      state: 'committed',
      record: expect.objectContaining({ outcome: 'admitted', replayed: true }),
    });
    expect(inputs).toEqual([observation, observation]);
    expect(staging.retained()).toEqual([]);
  });

  it('resumes no attempt of another operation kind', async () => {
    const operations = createUserCardsOperations({
      storage: null,
      client: client({
        stageImportEntries: () => Promise.reject(new ApplicationError('unavailable', 'Lost.')),
      }),
    });
    const staging = captureStaging(operations.account('alice'));
    const scope = operations.account('alice');
    scope.stageImportEntries({
      sessionId: 'import-1',
      source: { kind: 'manual', id: 'import-1' },
      entries: [{ entryId: 'line-1', quantity: 1, printingId: 'printing-1' }],
    });

    expect(staging.retained()).toEqual([]);
    expect(staging.resume(scope.retained()[0]?.operationId ?? 'missing')).toBeNull();
  });

  it('replays a retained attempt under the recovering caller s cancellation scope', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const operations = createUserCardsOperations({
      storage: null,
      client: client({
        stageCaptureObservation: (_input, signal) => {
          signals.push(signal);
          if (signals.length === 1) {
            return Promise.reject(new ApplicationError('unavailable', 'Response lost.'));
          }
          const result: CaptureStageResult = {
            privateRevision: 'private-2',
            outcome: 'admitted',
            replayed: true,
            session: session(),
            entry: entry(),
          };
          return Promise.resolve(result);
        },
      }),
    });
    const staging = captureStaging(operations.account('alice'));
    const observed: StageCaptureInput = {
      sessionId: 'import-1',
      captureId: 'capture-1',
      printingId: 'printing-1',
    };
    // The view that dispatched the observation leaves: its caller scope is aborted, while the
    // attempt itself stays with the account (docs/user-cards.md#browser-operation-lifecycle).
    const departed = new AbortController();
    await staging.stage(observed, departed.signal).observe();
    departed.abort();

    const recovering = new AbortController();
    const resumed = staging.resume('capture-1', recovering.signal);
    await expect(resumed?.observe()).resolves.toEqual({
      state: 'committed',
      record: expect.objectContaining({ outcome: 'admitted', replayed: true }),
    });

    // The replay quotes the retained identity and input, but is cancelled with its new caller
    // instead of the scope its departure already aborted.
    expect(signals[0]).toBe(departed.signal);
    expect(signals[1]).toBe(recovering.signal);
  });
});

describe('capture browser composition', () => {
  it('ends one account s sessions and leaves another account s work running', async () => {
    const operations = createUserCardsOperations({ storage: null, client: client() });
    const closed: string[] = [];
    const opened: string[] = [];
    let identity = 0;
    const browser = createCaptureBrowser({
      userCards: operations,
      createRecognition: () => ({
        prepare: (request) =>
          Promise.resolve({
            sessionId: request.sessionId,
            engines: [...request.engines],
            versions: {},
            timings: {},
          }),
        recognize: () => ({
          initial: Promise.reject(new Error('The case runs no inference.')),
          completion: Promise.resolve(),
        }),
        dispose: () => {},
      }),
      engines: recognitionEngineNames(false),
      identity: () => `capture-${(identity += 1)}`,
    });
    const device = (accountId: string): CaptureBrowserDevice => ({
      openCamera: () => {
        opened.push(accountId);
        return Promise.resolve({
          preview: { stream: {} as MediaStream },
          sample: () => null,
          read: () => null,
          close: () => {
            closed.push(accountId);
          },
        });
      },
      release: () => {},
    });
    const alice = browser.create({
      accountId: 'alice',
      importId: 'import-1',
      device: device('alice'),
    });
    const bob = browser.create({
      accountId: 'bob',
      importId: 'import-1',
      device: device('bob'),
    });
    await alice.start();
    await bob.start();
    expect(opened).toEqual(['alice', 'bob']);

    browser.endAccount('alice');

    // Only the departed account's camera is released, and its stale capability starts no further
    // work or delivery (docs/architecture.md#runtime-boundaries).
    expect(closed).toEqual(['alice']);
    await alice.start();
    expect(opened).toEqual(['alice', 'bob']);
    const departed: CaptureSnapshot[] = [];
    alice.observe((snapshot) => {
      departed.push(snapshot);
    });
    expect(departed).toEqual([]);

    // The presented account's own session keeps running.
    const presented: CaptureSnapshot[] = [];
    bob.observe((snapshot) => {
      presented.push(snapshot);
    });
    expect(presented.at(-1)?.running).toBe(true);
    expect(() => browser.endAccount('carol')).not.toThrow();
    bob.dispose();
  });
});

describe('capture admission', () => {
  it('compares sampled frames by their brightness, never by identity', () => {
    expect(frameDifference([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(frameDifference([1, 2, 3], [3, 2, 1])).toBeGreaterThan(0);
    expect(frameDifference([1, 2], [1, 2, 3])).toBe(Number.POSITIVE_INFINITY);
    expect(frameDifference([], [])).toBe(Number.POSITIVE_INFINITY);
  });

  it('requires a settled window and a retry wait before the next attempt', () => {
    const admission = createCaptureAdmission();
    const steady = [120, 120, 120, 120];

    admission.observe(steady, 0);
    expect(admission.ready(CAPTURE_LIMITS.settleMs)).toBe(true);
    admission.started(CAPTURE_LIMITS.settleMs);
    expect(admission.ready(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.sampleMs)).toBe(false);

    admission.settled(1, 'accepted', CAPTURE_LIMITS.settleMs);
    expect(admission.ready(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted - 1)).toBe(
      false,
    );
    expect(admission.ready(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted)).toBe(true);

    // A different scene than the one the attempt read is due as soon as it settles.
    admission.started(CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted);
    admission.observe(
      [10, 10, 10, 10],
      CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted + 1,
    );
    admission.observe(
      [10, 10, 10, 10],
      CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted + 2,
    );
    expect(
      admission.ready(
        CAPTURE_LIMITS.settleMs + CAPTURE_LIMITS.retryMs.accepted + 2 + CAPTURE_LIMITS.settleMs,
      ),
    ).toBe(true);
  });

  it('delivers a success cue and an error cue at most once per attempt', () => {
    const admission = createCaptureAdmission();

    expect(admission.settled(1, 'accepted', 0)).toBe('accepted');
    expect(admission.settled(1, 'accepted', 1)).toBeNull();
    expect(admission.settled(1, 'unavailable', 2)).toBe('error');
    expect(admission.settled(1, 'unresolved', 3)).toBeNull();
    expect(admission.settled(2, 'repeat', 4)).toBe('repeat');
    expect(admission.settled(2, 'guidance', 5)).toBeNull();
  });
});

describe('browser capture device', () => {
  it('omits the camera of an environment that grants none', () => {
    const device = createBrowserCaptureDevice({ media: undefined });

    expect(device.openCamera).toBeUndefined();
    expect(() => device.release()).not.toThrow();
  });

  it('presents the granted stream and releases every track it handed out', async () => {
    const stopped: string[] = [];
    const stream = {
      getTracks: () => [{ stop: () => stopped.push('back') }],
    } as unknown as MediaStream;
    const constraints: MediaStreamConstraints[] = [];
    const played: MediaStream[] = [];
    const surface: CaptureVideoSurface = {
      videoWidth: 0,
      videoHeight: 0,
      srcObject: null,
      play: () => {
        played.push(surface.srcObject as MediaStream);
        return Promise.resolve();
      },
      pause: () => {},
    };
    const device = createBrowserCaptureDevice({
      media: {
        getUserMedia(received) {
          constraints.push(received);
          return Promise.resolve(stream);
        },
      },
      createSurface: () => surface,
    });

    const camera = await device.openCamera?.();
    expect(camera?.preview.stream).toBe(stream);
    expect(constraints).toEqual([{ video: { facingMode: 'environment' }, audio: false }]);
    expect(played).toEqual([stream]);
    // Without a browsing document the device reads no frame; the browser journeys cover sampling.
    expect(camera?.sample()).toBeNull();
    expect(camera?.read()).toBeNull();

    camera?.close();
    expect(stopped).toEqual(['back']);
    expect(surface.srcObject).toBeNull();

    await device.openCamera?.();
    device.release();
    expect(stopped).toEqual(['back', 'back']);
  });

  it('reports a stream a surface cannot present as a camera failure', async () => {
    const stream = { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
    const device = createBrowserCaptureDevice({
      media: { getUserMedia: () => Promise.resolve(stream) },
      createSurface: () => null,
    });

    await expect(device.openCamera?.()).rejects.toThrow(/surface/);
  });
});
