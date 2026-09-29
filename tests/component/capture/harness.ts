/**
 * Controlled boundaries of the Capture component tests (docs/capture.md#replacement-evidence,
 * docs/testing.md#capture).
 *
 * The harness replaces the three capabilities one session receives: a device that presents
 * supplied frames, the real Recognition lifecycle over a scripted engine pipeline, and UserCards'
 * real browser operation lifecycle over a scripted client whose requests the case settles by
 * identity. The clock is controlled, so the hands-free loop runs deterministically.
 */

import { ApplicationError, type ApplicationFailureCode } from '../../../src/application/index.js';
import {
  captureStaging,
  createCapture,
  type Capture,
  type CaptureCamera,
  type CaptureDevice,
  type CaptureEvent,
  type CaptureReviewChange,
  type CaptureSnapshot,
  type CaptureTimers,
} from '../../../src/capture/index.js';
import {
  createRecognition,
  recognitionEngineNames,
  type RecognitionEngineOutcome,
  type RecognitionEnginePreparation,
  type RecognitionEnginePipeline,
} from '../../../src/recognition/index.js';
import {
  createUserCardsOperations,
  type UserCardsBrowserClient,
} from '../../../src/usercards/browser.js';
import type {
  AttachImportCandidatesInput,
  CaptureStageResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportSession,
  StageCaptureInput,
} from '../../../src/usercards/index.js';

/** One frame the controlled device hands to Recognition. */
export interface TestFrame {
  readonly width: number;
  readonly height: number;
}

/** One reading the scripted engine pipeline reports for the next attempt. */
export interface ScriptedReading {
  readonly status?: 'unknown' | 'possible';
  readonly candidates?: readonly { readonly cardId: string; readonly printingId: string }[];
  readonly printingId?: string | null;
  readonly cardPresence?: 'single' | 'none' | 'multiple' | 'ambiguous' | null;
  readonly provisional?: boolean;
  readonly later?: ScriptedReading | readonly ScriptedReading[];
}

/** One request the case settles by its identity, like the private client of a deployment. */
export interface RecordedRequest<Input> {
  readonly id: number;
  readonly input: Input;
  readonly aborted: boolean;
  settle(value: unknown): void;
  fail(code: ApplicationFailureCode, message: string): void;
}

/** The clock and timer the session samples with; advancing it runs the loop deterministically. */
export class TestClock implements CaptureTimers {
  private current = 0;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { at: number; task: () => void }>();

  now(): number {
    return this.current;
  }

  schedule(task: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.tasks.set(handle, { at: this.current + delayMs, task });
    return handle;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  /** Runs every task due within the advance, in due order, flushing promises between steps. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        break;
      }
      this.tasks.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      due[1].task();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

/** Runs the promise chains a sampling step or a settled request started. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 24; index += 1) {
    await Promise.resolve();
  }
}

/** The steady signature of a motionless scene. */
export const still = [120, 120, 120, 120];

export interface CaptureHarness {
  readonly capture: Capture;
  readonly clock: TestClock;
  /** Every state the case observed, in delivery order. */
  readonly states: readonly CaptureSnapshot[];
  current(): CaptureSnapshot;
  /** Events of every observed state, without repeating an identity. */
  events(): readonly CaptureEvent[];
  captures(): readonly RecordedRequest<StageCaptureInput>[];
  attachments(): readonly RecordedRequest<AttachImportCandidatesInput>[];
  preparations(): readonly string[];
  recognitions(): readonly {
    readonly captureId: string;
    readonly attempt: number;
    readonly frame: TestFrame;
  }[];
  camera(): { readonly opened: number; readonly released: number; readonly closed: boolean };
  /** Suspends the next camera request until the case grants or denies it. */
  holdCamera(): void;
  /** Grants the oldest suspended camera request with a fresh open camera. */
  grantCamera(): void;
  /** Denies the oldest suspended camera request with the deployment's failure. */
  denyCamera(message: string): void;
  /** Suspends the next preparation until the case completes or rejects it. */
  holdPreparation(): void;
  /** Completes the oldest suspended preparation. */
  completePreparation(): void;
  /** Rejects the oldest suspended preparation with the message the runtime reported. */
  rejectPreparation(message: string): void;
  /** Creates another session of the same account and import, as returning to the page does. */
  reopen(): Capture;
  /** Changes of the pending review the session reported to its page. */
  reviews(): readonly CaptureReviewChange[];
  /**
   * Presents one scene: the signature the stability gate reads, the frame Recognition gets, and
   * whether the scene moves (a moving scene never settles).
   */
  scene(signature: readonly number[] | null, frame: TestFrame | null, moving?: boolean): void;
  script(reading: ScriptedReading): void;
  completeLater(): void;
  failPreparation(message: string): void;
  settleCapture(request: RecordedRequest<StageCaptureInput>, result: CaptureStageResult): void;
  settleAttach(
    request: RecordedRequest<AttachImportCandidatesInput>,
    result: ImportEntryChangeResult,
  ): void;
  /** Runs the hands-free loop for `ms` milliseconds of the controlled clock. */
  advance(ms: number): Promise<void>;
}

export function session(overrides: Partial<ImportSession> = {}): ImportSession {
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
    ...overrides,
  };
}

export function entry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'capture-1',
    sessionId: 'import-1',
    position: 1,
    state: 'pending',
    cardId: 'card-bolt',
    printingId: 'printing-bolt',
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [],
    sourceLine: null,
    revision: 3,
    ...overrides,
  };
}

function unused(): Promise<never> {
  return Promise.reject(new Error('The case did not script this private operation.'));
}

export interface CaptureHarnessOptions {
  /** Whether this deployment holds a camera; a deployment without one omits the operation. */
  readonly camera?: boolean;
  /** Failure the camera request reports, after which the session stays startable. */
  readonly denial?: string;
  /** One unfinished observation of an earlier session, as a reloaded view would find it. */
  readonly retained?: StageCaptureInput;
}

export function createCaptureHarness(options: CaptureHarnessOptions = {}): CaptureHarness {
  let sequence = 0;
  let identitySerial = 0;
  const clock = new TestClock();
  const states: CaptureSnapshot[] = [];
  const captureRequests: RecordedRequest<StageCaptureInput>[] = [];
  const attachmentRequests: RecordedRequest<AttachImportCandidatesInput>[] = [];
  const preparations: string[] = [];
  const recognitions: { captureId: string; attempt: number; frame: TestFrame }[] = [];
  const scripts: ScriptedReading[] = [];
  const completions: (() => void)[] = [];
  const reviews: CaptureReviewChange[] = [];
  let preparationFailure: string | null = null;
  let heldPreparationCount = 0;
  let heldCameraCount = 0;
  let signature: readonly number[] | null = still;
  let frame: TestFrame | null = { width: 320, height: 240 };
  let moving = false;
  let sampleTick = 0;
  let opened = 0;
  let released = 0;
  /** Cameras the device handed out and has not released yet, so a replacement stays separate. */
  const liveCameras = new Set<CaptureCamera<TestFrame>>();
  /** Camera requests the case holds open, oldest first. */
  const heldCameras: { grant(): void; deny(message: string): void }[] = [];
  /** Preparations the case holds open, oldest first. */
  const heldPreparations: { complete(): void; reject(message: string): void }[] = [];

  /** One open camera of the device; each request gets its own lifetime. */
  function createCamera(): CaptureCamera<TestFrame> {
    const camera: CaptureCamera<TestFrame> = {
      preview: { stream: {} as MediaStream },
      sample: () => {
        if (!liveCameras.has(camera) || signature === null) {
          return null;
        }
        sampleTick += 1;
        return moving && sampleTick % 2 === 1 ? signature.map((value) => value + 40) : signature;
      },
      read: () => (liveCameras.has(camera) ? frame : null),
      close: () => {
        liveCameras.delete(camera);
      },
    };
    liveCameras.add(camera);
    return camera;
  }

  const device: CaptureDevice<TestFrame> = {
    release: () => {
      released += 1;
      for (const camera of [...liveCameras]) {
        camera.close();
      }
    },
  };
  if (options.camera !== false) {
    device.openCamera = async (): Promise<CaptureCamera<TestFrame>> => {
      opened += 1;
      if (options.denial !== undefined) {
        throw new Error(options.denial);
      }
      if (heldCameraCount === 0) {
        return createCamera();
      }
      heldCameraCount -= 1;
      return new Promise<CaptureCamera<TestFrame>>((resolve, reject) => {
        heldCameras.push({
          grant: () => resolve(createCamera()),
          deny: (message) => reject(new Error(message)),
        });
      });
    };
  }

  function record<Input>(
    requests: RecordedRequest<Input>[],
    input: Input,
    signal?: AbortSignal,
  ): Promise<unknown> {
    sequence += 1;
    const id = sequence;
    let settle!: (value: unknown) => void;
    let fail!: (cause: Error) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    requests.push({
      id,
      input,
      get aborted() {
        return signal?.aborted === true;
      },
      settle,
      fail(code, message) {
        fail(new ApplicationError(code, message));
      },
    });
    return promise;
  }

  const client: UserCardsBrowserClient = {
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
    stageCaptureObservation: (input, signal) =>
      record(captureRequests, input, signal) as Promise<CaptureStageResult>,
    reviewImportEntry: unused,
    attachImportCandidates: (input, signal) =>
      record(attachmentRequests, input, signal) as Promise<ImportEntryChangeResult>,
    discardImportEntry: unused,
    discardImportSession: unused,
    confirmImport: unused,
    recoverImportOperation: unused,
  };
  const userCards = createUserCardsOperations({ client, storage: null });
  if (options.retained !== undefined) {
    // The earlier session dispatched this observation and never learned its outcome, so the
    // account keeps it under its capture identity (docs/user-cards.md#browser-operation-lifecycle).
    userCards.account('alice').stageCaptureObservation(options.retained);
    captureRequests[captureRequests.length - 1]?.fail('unavailable', 'Response lost.');
  }

  /** One session of this account and import; the account's retained attempts outlive it. */
  function openSession(): Capture {
    const capture = createCapture({
      accountId: 'alice',
      importId: 'import-1',
      device,
      staging: captureStaging(userCards.account('alice')),
      engines: recognitionEngineNames(false),
      createRecognition: () =>
        createRecognition<TestFrame>({
          createEnginePipeline: () => pipeline(),
          catalog: {
            resolve: (references) =>
              Promise.resolve({
                revision: {
                  revisionId: 'revision-1',
                  sourceName: 'fixture',
                  sourceVersion: '1',
                  publishedAt: '2026-09-01T00:00:00.000Z',
                },
                cards: new Map(
                  references.flatMap((reference) =>
                    reference.kind === 'card'
                      ? [
                          [
                            reference.cardId,
                            {
                              cardId: reference.cardId,
                              name: reference.cardId,
                              names: [],
                              rulesText: null,
                              typeLine: null,
                              colors: [],
                              colorIdentity: [],
                              manaValue: null,
                            },
                          ] as const,
                        ]
                      : [],
                  ),
                ),
                printings: new Map(
                  references.flatMap((reference) =>
                    reference.kind === 'printing'
                      ? [
                          [
                            reference.printingId,
                            {
                              printingId: reference.printingId,
                              cardId: reference.printingId.replace('printing-', 'card-'),
                              edition: 'TST',
                              collectorNumber: '149',
                              language: 'en',
                              finishes: ['nonfoil', 'foil'],
                              physical: true,
                              images: { small: null, normal: null, large: null, artCrop: null },
                            },
                          ] as const,
                        ]
                      : [],
                  ),
                ),
                missing: [],
              }),
          },
          inspectFrame: (received) => ({
            width: received.width,
            height: received.height,
            format: 'png',
            encodedBytes: null,
          }),
        }),
      identity: () => {
        identitySerial += 1;
        return `capture-${identitySerial}`;
      },
      timers: clock,
      reviewed: (change) => {
        reviews.push(change);
      },
    });
    capture.observe((snapshot) => {
      states.push(snapshot);
    });
    return capture;
  }

  const capture = openSession();

  function pipeline(): RecognitionEnginePipeline<TestFrame> {
    return {
      prepare(request) {
        preparations.push(request.sessionId);
        if (preparationFailure !== null) {
          const message = preparationFailure;
          preparationFailure = null;
          return Promise.reject(new Error(message));
        }
        if (heldPreparationCount > 0) {
          heldPreparationCount -= 1;
          return new Promise<RecognitionEnginePreparation>((resolve, reject) => {
            heldPreparations.push({
              complete: () => resolve({ versions: { engine: 'scripted-1' } }),
              reject: (message) => reject(new Error(message)),
            });
          });
        }
        return Promise.resolve({ versions: { engine: 'scripted-1' } });
      },
      recognize(received, attempt) {
        recognitions.push({
          captureId: attempt.captureId,
          attempt: attempt.attempt,
          frame: received,
        });
        const script = scripts.shift() ?? { status: 'unknown' as const };
        const early = outcome(script);
        if (script.later === undefined) {
          return Promise.resolve(early);
        }
        attempt.onReading?.(early);
        const comparisons = Array.isArray(script.later) ? [...script.later] : [script.later];
        return new Promise<RecognitionEngineOutcome>((resolve) => {
          const deliver = (): void => {
            const reading = comparisons.shift();
            if (reading === undefined) {
              throw new Error('A scripted comparison is required.');
            }
            if (comparisons.length === 0) {
              resolve(outcome(reading));
            } else {
              attempt.onReading?.(outcome(reading));
              completions.push(deliver);
            }
          };
          completions.push(deliver);
        });
      },
      dispose() {
        /* The case asserts release through the device and through suppressed later readings. */
      },
    };
  }

  function outcome(scripted: ScriptedReading): RecognitionEngineOutcome {
    const candidates = scripted.candidates ?? [];
    return {
      status: scripted.status ?? (candidates.length > 0 ? 'possible' : 'unknown'),
      candidates: candidates.map((candidate) => ({
        cardId: candidate.cardId,
        printingId: candidate.printingId,
        name: '',
        score: null,
      })),
      evidence: {
        printingId: scripted.printingId ?? null,
        titleLanguage: null,
        titleCorroborated: false,
        cardPresence: scripted.cardPresence === undefined ? 'single' : scripted.cardPresence,
      },
      provisional: scripted.provisional === true,
      versions: { engine: 'scripted-1' },
      timings: { recognizeMs: 1 },
    };
  }

  return {
    capture,
    clock,
    states,
    current: () => states[states.length - 1] ?? failNoState(),
    events() {
      const seen = new Set<number>();
      const all: CaptureEvent[] = [];
      for (const state of states) {
        for (const event of state.events) {
          if (!seen.has(event.sequence)) {
            seen.add(event.sequence);
            all.push(event);
          }
        }
      }
      return all;
    },
    captures: () => captureRequests,
    attachments: () => attachmentRequests,
    preparations: () => preparations,
    recognitions: () => recognitions,
    camera: () => ({ opened, released, closed: liveCameras.size === 0 }),
    holdCamera: () => {
      heldCameraCount += 1;
    },
    grantCamera: () => {
      heldCameras.shift()?.grant();
    },
    denyCamera: (message) => {
      heldCameras.shift()?.deny(message);
    },
    holdPreparation: () => {
      heldPreparationCount += 1;
    },
    completePreparation: () => {
      heldPreparations.shift()?.complete();
    },
    rejectPreparation: (message) => {
      heldPreparations.shift()?.reject(message);
    },
    reopen: () => openSession(),
    reviews: () => reviews,
    scene: (nextSignature, nextFrame, nextMoving = false) => {
      signature = nextSignature;
      frame = nextFrame;
      moving = nextMoving;
    },
    script: (reading) => {
      scripts.push(reading);
    },
    completeLater: () => {
      for (const complete of completions.splice(0)) {
        complete();
      }
    },
    failPreparation: (message) => {
      preparationFailure = message;
    },
    settleCapture: (request, result) => request.settle(result),
    settleAttach: (request, result) => request.settle(result),
    advance: (ms) => clock.advance(ms),
  };
}

function failNoState(): never {
  throw new Error('The case observed no capture state.');
}
