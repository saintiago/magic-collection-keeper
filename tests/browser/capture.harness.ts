/**
 * Browser-side harness of hands-free camera capture (docs/user-interface.md#capture-and-review,
 * docs/recognition.md#interface, docs/user-cards.md#import-and-capture-state,
 * docs/testing.md#browser-and-recognition-evidence).
 *
 * The harness installs the real shell with the real Import page and replaces the boundaries around
 * them: identity, the device capability with a synthetic canvas camera, the Recognition contract
 * through its real lifecycle over a scripted engine pipeline, and the private component access
 * Application supplies. Every pending-import read, capture staging, late attachment and catalog
 * resolve the page issues is recorded and settled from the journey, so the journeys drive the real
 * sampling, admission, staging and review behavior while observing exactly what crossed the
 * component contracts.
 */

import { idleProgress } from './card-list-progress.js';

import {
  ApplicationError,
  inspectCanvasFrame,
  type ApplicationFailureCode,
  type SearchClient,
  type UserInterfaceCapabilities,
} from '../../src/application/index.js';
import {
  createUserCardsOperations,
  type UserCardsBrowserClient,
} from '../../src/usercards/browser.js';
import { createCardListBrowser } from '../../src/card-list/index.js';
// A type-only import of the Catalog public entry keeps the provider barrel, including its Node-only
// synchronization job, out of the browser bundle (docs/application.md#interface).
import type {
  CardRecord,
  Catalog,
  CatalogReference,
  CatalogResolution,
  PrintingRecord,
} from '../../src/catalog/index.js';
import {
  createRecognition,
  recognitionEngineNames,
  type Recognition,
  type RecognitionEngineOutcome,
  type RecognitionEnginePipeline,
} from '../../src/recognition/index.js';
import {
  createBrowserCaptureDevice,
  createCaptureBrowser,
  type CaptureCamera,
  type CaptureDevice,
} from '../../src/capture/index.js';
import type {
  AttachImportCandidatesInput,
  CaptureStageResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportEntryListResult,
  ImportSession,
  ImportSessionListResult,
  StageCaptureInput,
} from '../../src/usercards/index.js';
import {
  createImportPages,
  createUserInterface,
  type UiAccount,
  type UiIdentity,
  type UiView,
  type UserInterface,
} from '../../src/ui/index.js';

import { browserAttemptStorage, unusedUserCardsClient } from './unused-usercards.js';

interface Pending {
  resolve(value: unknown): void;
  reject(cause: Error): void;
}

/** One recorded request of one operation: its identity, arguments and withdrawal state. */
export interface UiCaptureRequest<Arguments = unknown> {
  readonly id: number;
  readonly arguments: Arguments;
  readonly aborted: boolean;
}

/** One pending session list request the page issued. */
export interface UiCaptureSessionsRequest {
  readonly pageSize: number | null;
  readonly continuation: string | null;
}

/** One pending entry page request the page issued. */
export interface UiCaptureEntriesRequest {
  readonly sessionId: string;
  readonly pageSize: number | null;
  readonly continuation: string | null;
}

/**
 * One reading the scripted engine pipeline reports for the next attempt: its status, candidates,
 * geometry and provisional state, optionally with a later comparison the journey completes.
 */
export interface UiCaptureReading {
  readonly status?: 'unknown' | 'possible';
  readonly candidates?: readonly { readonly cardId: string; readonly printingId: string }[];
  readonly printingId?: string | null;
  readonly cardPresence?: 'single' | 'none' | 'multiple' | 'ambiguous' | null;
  readonly titleCorroborated?: boolean;
  readonly provisional?: boolean;
  /** A later comparison of the same attempt, delivered before the attempt completes. */
  readonly later?: Omit<UiCaptureReading, 'later'> | Omit<UiCaptureReading, 'later'>[];
}

/** Synthetic scenes the camera can present; each paints a distinct frame. */
export interface UiCaptureScenes {
  readonly bolt: { readonly background: string; readonly card: string };
  readonly ring: { readonly background: string; readonly card: string };
  readonly empty: { readonly background: string; readonly card: null };
}

export interface UiCaptureControl {
  log(): string[];
  readonly accountId: string | null;
  sessions(): readonly UiCaptureRequest<UiCaptureSessionsRequest>[];
  entries(): readonly UiCaptureRequest<UiCaptureEntriesRequest>[];
  captures(): readonly UiCaptureRequest<StageCaptureInput>[];
  attachments(): readonly UiCaptureRequest<AttachImportCandidatesInput>[];
  /** Sessions the page prepared through the Recognition contract, with their engine names. */
  preparations(): readonly { readonly sessionId: string; readonly engines: readonly string[] }[];
  /** Attempts the scripted pipeline ran, in order, with the frame each received. */
  recognitions(): readonly {
    readonly captureId: string;
    readonly attempt: number;
    readonly width: number;
    readonly height: number;
  }[];
  /** References every catalog resolve asked about, in order. */
  catalogRequests(): readonly (readonly CatalogReference[])[];
  /** The synthetic camera the device grants and the resources it still holds. */
  camera(): {
    readonly opened: number;
    readonly released: number;
    readonly closed: boolean;
    readonly liveTracks: number;
  };
  /** Presents one synthetic scene to the running camera. */
  show(scene: keyof UiCaptureScenes): void;
  /** Presents the camera at one frame size, so the capture view bounds a large video frame. */
  cameraSize(width: number, height: number): void;
  /** Refuses every following camera request with the supplied permission failure. */
  denyCamera(message: string): void;
  /** Queues one reading the next recognition attempt reports. */
  scriptReading(reading: UiCaptureReading): void;
  /** Fails the next recognition preparation with the supplied message. */
  failPreparation(message: string): void;
  /** Completes the later comparison the current attempt is waiting for. */
  completeLater(): void;
  settleSessions(
    id: number,
    sessions: readonly ImportSession[],
    continuation?: string | null,
  ): void;
  settleEntries(
    id: number,
    result: {
      readonly session: ImportSession;
      readonly entries: readonly ImportEntry[];
      readonly continuation?: string | null;
    },
  ): void;
  settleCapture(id: number, result: Omit<CaptureStageResult, 'privateRevision'>): void;
  settleAttach(
    id: number,
    result: { readonly entry: ImportEntry; readonly session: ImportSession },
  ): void;
  fail(
    id: number,
    failure: { readonly code: ApplicationFailureCode; readonly message: string },
  ): void;
  signOut(): void;
  navigate(view: UiView): void;
  dispose(): void;
}

/** The published revision the harness resolves catalog records against. */
const harnessRevision = {
  revisionId: 'capture-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** Installs the Import page with the synthetic camera into `root`. */
export function installCaptureHarness(root: Element | null): UiCaptureControl {
  if (root === null) {
    throw new Error('The capture journey needs its root element.');
  }
  const document = root.ownerDocument;
  const log: string[] = [];
  let sequence = 0;
  let account: UiAccount | null = { accountId: 'alice', displayName: 'Alice' };
  const listeners = new Set<(account: UiAccount | null) => void>();
  const pending = new Map<number, Pending>();
  const sessionRequests: UiCaptureRequest<UiCaptureSessionsRequest>[] = [];
  const entryRequests: UiCaptureRequest<UiCaptureEntriesRequest>[] = [];
  const captureRequests: UiCaptureRequest<StageCaptureInput>[] = [];
  const attachmentRequests: UiCaptureRequest<AttachImportCandidatesInput>[] = [];
  const preparations: { sessionId: string; engines: readonly string[] }[] = [];
  const recognitions: { captureId: string; attempt: number; width: number; height: number }[] = [];
  const catalogRequests: CatalogReference[][] = [];
  const scripts: UiCaptureReading[] = [];
  const laterCompletions: (() => void)[] = [];
  let preparationFailure: string | null = null;
  let cameraDenial: string | null = null;
  let cameraOpened = 0;
  let cameraReleased = 0;
  let cameraClosed = false;
  let scene: keyof UiCaptureScenes = 'bolt';
  let canvas: HTMLCanvasElement | null = null;
  let stream: MediaStream | null = null;
  let painting: number | null = null;
  let videoWidth = 320;
  let videoHeight = 240;

  const scenes: UiCaptureScenes = {
    bolt: { background: '#26402a', card: '#f4e7c5' },
    ring: { background: '#402636', card: '#c9dcf4' },
    empty: { background: '#2a2a2a', card: null },
  };

  const cards: CardRecord[] = [
    {
      cardId: 'card-bolt',
      name: 'Lightning Bolt',
      names: [{ language: 'en', name: 'Lightning Bolt' }],
      rulesText: null,
      typeLine: null,
      colors: [],
      colorIdentity: [],
      manaValue: null,
    },
    {
      cardId: 'card-ring',
      name: 'Sol Ring <img src=x onerror=alert(1)>',
      names: [{ language: 'en', name: 'Sol Ring <img src=x onerror=alert(1)>' }],
      rulesText: null,
      typeLine: null,
      colors: [],
      colorIdentity: [],
      manaValue: null,
    },
  ];
  const printings: PrintingRecord[] = [
    {
      printingId: 'printing-bolt',
      cardId: 'card-bolt',
      edition: 'TST',
      collectorNumber: '149',
      language: 'en',
      finishes: ['nonfoil', 'foil'],
      physical: true,
      images: { small: null, normal: null, large: null, artCrop: null },
    },
    {
      printingId: 'printing-ring',
      cardId: 'card-ring',
      edition: 'TST',
      collectorNumber: '264',
      language: 'en',
      finishes: ['nonfoil'],
      physical: true,
      images: { small: null, normal: null, large: null, artCrop: null },
    },
  ];

  /** Records one request and returns the promise the journey settles by its identity. */
  function begin<Arguments>(
    requests: UiCaptureRequest<Arguments>[],
    arguments_: Arguments,
    signal?: AbortSignal,
  ): Promise<unknown> {
    sequence += 1;
    const id = sequence;
    requests.push({
      id,
      arguments: arguments_,
      get aborted() {
        return signal?.aborted === true;
      },
    });
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function settle<Value>(id: number, value: Value, wrap: (value: Value) => unknown): void {
    const waiting = pending.get(id);
    if (waiting === undefined) {
      throw new Error(`No capture journey request ${id} is waiting.`);
    }
    pending.delete(id);
    waiting.resolve(wrap(value));
  }

  const identity: UiIdentity = {
    current: () => account,
    signIn: () => {
      report({ accountId: 'bob', displayName: 'Bob' });
    },
    signOut: () => {
      report(null);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function report(next: UiAccount | null): void {
    account = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }

  const request = Object.assign(
    async (path: string) => {
      log.push(`request:${path}`);
      return {};
    },
    { endSession: () => log.push('session-ended') },
  );

  /** Answers the references from the declared fixture, like the published Catalog. */
  const catalog: Catalog = {
    resolve(references) {
      catalogRequests.push([...references]);
      return Promise.resolve(resolution(references));
    },
    listCardPrintings() {
      return Promise.reject(new Error('The capture page reads no card printing page.'));
    },
  };

  const search: SearchClient = {
    execute() {
      return Promise.reject(new Error('The capture journeys run no search.'));
    },
    counts() {
      return Promise.reject(new Error('The capture journeys read no private counts.'));
    },
    observe() {
      return Promise.reject(new Error('The capture journeys observe no progress.'));
    },
  };

  const scriptedUserCards: UserCardsBrowserClient = {
    ...unusedUserCardsClient,
    listImportSessions(options, signal) {
      return begin(
        sessionRequests,
        { pageSize: options?.pageSize ?? null, continuation: options?.continuation ?? null },
        signal,
      ) as Promise<ImportSessionListResult>;
    },
    listImportEntries(input, signal) {
      return begin(
        entryRequests,
        {
          sessionId: input.sessionId,
          pageSize: input.pageSize ?? null,
          continuation: input.continuation ?? null,
        },
        signal,
      ) as Promise<ImportEntryListResult>;
    },
    stageCaptureObservation(input, signal) {
      return begin(captureRequests, input, signal) as Promise<CaptureStageResult>;
    },
    attachImportCandidates(input, signal) {
      return begin(attachmentRequests, input, signal) as Promise<ImportEntryChangeResult>;
    },
  };

  const userCards = createUserCardsOperations({
    client: scriptedUserCards,
    storage: browserAttemptStorage(),
  });
  // Application ends the UserCards scope of the account it leaves, so no retained attempt or read
  // of that account reaches the account that signs in next (docs/architecture.md#runtime-boundaries).
  let scopedAccountId: string | null = account?.accountId ?? null;
  listeners.add((next) => {
    const nextAccountId = next?.accountId ?? null;
    if (nextAccountId !== scopedAccountId) {
      if (scopedAccountId !== null) {
        userCards.release(scopedAccountId);
      }
      scopedAccountId = nextAccountId;
    }
  });
  /** The Recognition contract of one capture session, over the scripted engine pipeline. */
  const createRecognitionContract = (): Recognition<HTMLCanvasElement> => {
    const recognition = createRecognition<HTMLCanvasElement>({
      createEnginePipeline: () => scriptedPipeline(),
      catalog,
      inspectFrame: inspectCanvasFrame,
    });
    return {
      ...recognition,
      recognize(request) {
        const attempt = recognition.recognize({
          ...request,
          onReading(reading) {
            request.onReading?.(reading);
            log.push('recognition-reading-delivered');
          },
        });
        return {
          ...attempt,
          completion: attempt.completion.then(() => {
            log.push('recognition-completed');
          }),
        };
      },
    };
  };
  const capabilities: UserInterfaceCapabilities = {
    settings: {
      environment: 'test',
      apiBaseUrl: 'https://api.test.keeper.example',
      authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
      recognition: { cloudEnabled: false, computeBaseUrl: null },
      capabilities: { sourceImports: false },
    },
    identity,
    request,
    catalog,
    search,
    userCards,
    cardList: createCardListBrowser({ progress: idleProgress, search, catalog, userCards }),
    capture: createCaptureBrowser({
      userCards,
      createRecognition: createRecognitionContract,
      engines: recognitionEngineNames(false),
    }),
    indexing: idleProgress,
  };

  const shell: UserInterface = createUserInterface({
    root,
    capabilities,
    identity,
    device: syntheticDevice(),
    pages: createImportPages(),
  });

  return {
    log: () => [...log],
    get accountId() {
      return account?.accountId ?? null;
    },
    sessions: () => sessionRequests.map((entry) => ({ ...entry })),
    entries: () => entryRequests.map((entry) => ({ ...entry })),
    captures: () => captureRequests.map((entry) => ({ ...entry })),
    attachments: () => attachmentRequests.map((entry) => ({ ...entry })),
    preparations: () => preparations.map((entry) => ({ ...entry, engines: [...entry.engines] })),
    recognitions: () => recognitions.map((entry) => ({ ...entry })),
    catalogRequests: () => catalogRequests.map((references) => [...references]),
    camera: () => ({
      opened: cameraOpened,
      released: cameraReleased,
      closed: cameraClosed,
      liveTracks: stream?.getTracks().filter((track) => track.readyState === 'live').length ?? 0,
    }),
    show: (next) => {
      scene = next;
      paint();
    },
    cameraSize: (width, height) => {
      videoWidth = width;
      videoHeight = height;
      if (canvas !== null) {
        canvas.width = width;
        canvas.height = height;
        paint();
      }
    },
    denyCamera: (message) => {
      cameraDenial = message;
    },
    scriptReading: (reading) => {
      scripts.push(reading);
    },
    failPreparation: (message) => {
      preparationFailure = message;
    },
    completeLater: () => {
      const completions = laterCompletions.splice(0);
      for (const complete of completions) {
        complete();
      }
    },
    settleSessions: (id, sessions, continuation = null) =>
      settle(id, { sessions, continuation }, (value) => ({
        privateRevision: 'private-1',
        sessions: value.sessions,
        continuation: value.continuation,
      })),
    settleEntries: (id, result) =>
      settle(id, result, (value) => ({
        privateRevision: 'private-1',
        session: value.session,
        entries: value.entries,
        continuation: value.continuation ?? null,
      })),
    settleCapture: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    settleAttach: (id, result) =>
      settle(id, result, (value) => ({ privateRevision: 'private-1', ...value })),
    fail: (id, failure) => {
      const waiting = pending.get(id);
      if (waiting === undefined) {
        throw new Error(`No capture journey request ${id} is waiting.`);
      }
      pending.delete(id);
      waiting.reject(new ApplicationError(failure.code, failure.message));
    },
    signOut: () => report(null),
    navigate: (view) => shell.navigate(view),
    dispose: () => shell.dispose(),
  };

  /** The scripted engine pipeline behind the real Recognition lifecycle. */
  function scriptedPipeline(): RecognitionEnginePipeline<HTMLCanvasElement> {
    return {
      prepare(preparation) {
        preparations.push({
          sessionId: preparation.sessionId,
          engines: [...preparation.engines],
        });
        if (preparationFailure !== null) {
          const message = preparationFailure;
          preparationFailure = null;
          return Promise.reject(new Error(message));
        }
        return Promise.resolve({ versions: { engine: 'scripted-1' } });
      },
      recognize(_frame, attempt) {
        recognitions.push({
          captureId: attempt.captureId,
          attempt: attempt.attempt,
          width: _frame.width,
          height: _frame.height,
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
              laterCompletions.push(deliver);
            }
          };
          laterCompletions.push(deliver);
        });
      },
      dispose() {
        log.push('recognition-disposed');
      },
    };
  }

  function outcome(reading: UiCaptureReading): RecognitionEngineOutcome {
    const candidates = reading.candidates ?? [];
    return {
      status: reading.status ?? (candidates.length > 0 ? 'possible' : 'unknown'),
      candidates: candidates.map((candidate) => ({
        cardId: candidate.cardId,
        printingId: candidate.printingId,
        name: '',
        score: null,
      })),
      evidence: {
        printingId: reading.printingId ?? null,
        titleLanguage: null,
        titleCorroborated: reading.titleCorroborated === true,
        cardPresence: reading.cardPresence === undefined ? 'single' : reading.cardPresence,
      },
      provisional: reading.provisional === true,
      versions: { engine: 'scripted-1' },
      timings: { recognizeMs: 1 },
    };
  }

  /**
   * The device capability of the journey: the real browser device over a synthetic canvas camera,
   * so the journeys exercise the shipped frame sampling and bounding against controlled scenes.
   */
  function syntheticDevice(): CaptureDevice<HTMLCanvasElement> {
    const device = createBrowserCaptureDevice({
      media: {
        getUserMedia() {
          cameraOpened += 1;
          if (cameraDenial !== null) {
            return Promise.reject(new Error(cameraDenial));
          }
          canvas ??= document.createElement('canvas');
          canvas.width = videoWidth;
          canvas.height = videoHeight;
          paint();
          stream = canvas.captureStream(15);
          cameraClosed = false;
          painting = document.defaultView?.setInterval(() => paint(), 80) ?? null;
          return Promise.resolve(stream);
        },
      },
    });
    return {
      async openCamera(): Promise<CaptureCamera<HTMLCanvasElement>> {
        const camera = await device.openCamera!();
        return {
          preview: camera.preview,
          sample: () => camera.sample(),
          read: () => camera.read(),
          close: () => {
            camera.close();
            closeCamera();
          },
        };
      },
      release() {
        cameraReleased += 1;
        return device.release();
      },
    };
  }

  function closeCamera(): void {
    cameraClosed = true;
    if (painting !== null) {
      document.defaultView?.clearInterval(painting);
      painting = null;
    }
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
    stream = null;
  }

  /** Paints one synthetic frame of the current scene. */
  function paint(): void {
    const context = canvas?.getContext('2d');
    if (context === null || context === undefined || canvas === null) {
      return;
    }
    const current = scenes[scene];
    context.fillStyle = current.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (current.card === null) {
      return;
    }
    context.fillStyle = current.card;
    context.fillRect(120, 40, 160, 160);
    context.fillStyle = current.background;
    context.fillRect(136, 56, 128, 64);
    context.fillRect(136, 132, 128, 52);
  }

  /** The fixture answer for exactly the requested references. */
  function resolution(references: readonly CatalogReference[]): CatalogResolution {
    const cardsById = new Map(cards.map((card) => [card.cardId, card] as const));
    const printingsById = new Map(
      printings.map((printing) => [printing.printingId, printing] as const),
    );
    return {
      revision: harnessRevision,
      cards: new Map(
        references.flatMap((reference) =>
          reference.kind === 'card' && cardsById.has(reference.cardId)
            ? [[reference.cardId, cardsById.get(reference.cardId)!] as const]
            : [],
        ),
      ),
      printings: new Map(
        references.flatMap((reference) =>
          reference.kind === 'printing' && printingsById.has(reference.printingId)
            ? [[reference.printingId, printingsById.get(reference.printingId)!] as const]
            : [],
        ),
      ),
      missing: references.filter((reference) =>
        reference.kind === 'card'
          ? !cardsById.has(reference.cardId)
          : !printingsById.has(reference.printingId),
      ),
    };
  }
}
