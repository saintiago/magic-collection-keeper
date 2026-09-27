/**
 * Component scope: the component-owned adapter from the preserved browser/Python engines to the
 * public pipeline port (docs/recognition.md#interface, docs/recognition.md#engines-and-assets).
 * The preserved browser, backend, hybrid, race and independent modules run for real behind stubbed
 * browser globals and an authenticated request stub, so candidate interpretation, the late hybrid
 * comparison, the independent session call limit and the local-only composition are verified
 * through the public lifecycle (docs/testing.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBrowserRecognitionPipeline,
  createRecognition,
  type PreservedRequest,
  type Recognition,
  type RecognitionReading,
} from '../../../src/recognition/index.js';

import { card, createCatalogStub, frameFacts, printing, type CatalogFixture } from './harness.js';

/** One printing as the preserved engines and their Catalog hydration report it. */
interface PreservedPrinting {
  readonly id: string;
  readonly oracle_id: string;
  readonly name: string;
  readonly collector_number: string;
  readonly set: string;
  readonly lang: string;
  readonly finishes: readonly string[];
}

const bolt: PreservedPrinting = {
  id: '00000000-0000-4000-8000-000000000101',
  oracle_id: '00000000-0000-4000-8000-000000000001',
  name: 'Lightning Bolt',
  collector_number: '149',
  set: 'm11',
  lang: 'en',
  finishes: ['nonfoil', 'foil'],
};
const counterspell: PreservedPrinting = {
  id: '00000000-0000-4000-8000-000000000202',
  oracle_id: '00000000-0000-4000-8000-000000000002',
  name: 'Counterspell',
  collector_number: '57',
  set: 'm11',
  lang: 'en',
  finishes: ['nonfoil', 'foil'],
};
const preservedPrintings = [bolt, counterspell];

/** The same identities as the published Catalog the component validates readings against. */
const catalogFixture: CatalogFixture = {
  cards: [card(bolt.oracle_id, bolt.name), card(counterspell.oracle_id, counterspell.name)],
  printings: [
    printing(bolt.id, bolt.oracle_id, bolt.collector_number, bolt.set),
    printing(
      counterspell.id,
      counterspell.oracle_id,
      counterspell.collector_number,
      counterspell.set,
    ),
  ],
};

const prepareRequest = { sessionId: 'session-1', engines: ['browser-onnx'] } as const;

/** One preserved service/worker response with the contract the retained resolution approves. */
function serviceReading(
  attempt: number,
  input: {
    readonly candidates?: readonly PreservedPrinting[];
    readonly status?: 'possible' | 'unknown';
    readonly evidence?: Record<string, unknown>;
    readonly versions?: Record<string, unknown>;
    readonly timings?: Record<string, number>;
  } = {},
): Record<string, unknown> {
  const candidates = input.candidates ?? [];
  return {
    contractVersion: 1,
    attempt,
    status: input.status ?? (candidates.length > 0 ? 'possible' : 'unknown'),
    candidates,
    evidence: input.evidence ?? {},
    versions: input.versions ?? {},
    timings: input.timings ?? {},
  };
}

class WorkerStub {
  static instances: WorkerStub[] = [];
  /** The result the preserved worker reports for one frame; tests replace it per case. */
  static result: (attempt: number) => Record<string, unknown> = (attempt) =>
    serviceReading(attempt);
  /** Holds frame results back so a case can control which engine answers first. */
  static hold: Promise<void> = Promise.resolve();

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    WorkerStub.instances.push(this);
  }

  postMessage(message: unknown): void {
    const posted = message as { type: string; attempt?: number };
    if (posted.type === 'init') {
      queueMicrotask(() => this.emit({ type: 'ready', metrics: { prepareMs: 1 } }));
    }
    if (posted.type === 'frame') {
      const attempt = posted.attempt ?? 0;
      void WorkerStub.hold.then(() =>
        this.emit({ type: 'result', result: WorkerStub.result(attempt) }),
      );
    }
  }

  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A canvas with the browser APIs the preserved ports read a capture through. */
function createCanvas(): HTMLCanvasElement {
  const pixels = { width: 200, height: 300 };
  return {
    ...pixels,
    getContext: () => ({
      fillStyle: '',
      fillRect: () => {},
      getImageData: () => ({
        width: pixels.width,
        height: pixels.height,
        data: new Uint8ClampedArray(pixels.width * pixels.height * 4),
      }),
    }),
    toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(['frame'])),
  } as unknown as HTMLCanvasElement;
}

interface TransportScript {
  readonly cloud?: (attempt: number) => unknown | Promise<unknown>;
  readonly independent?: (attempt: number) => unknown | Promise<unknown>;
}

interface Transport {
  readonly request: PreservedRequest;
  readonly recognizeAttempts: readonly number[];
  readonly independentAttempts: readonly number[];
}

/** One authenticated transport stub serving the preserved endpoints and Catalog hydration. */
function createTransport(script: TransportScript): Transport {
  const recognizeAttempts: number[] = [];
  const independentAttempts: number[] = [];
  const request: PreservedRequest = async (path, init) => {
    const posted = init?.body ? (JSON.parse(init.body) as { readonly attempt?: unknown }) : {};
    const attempt = typeof posted.attempt === 'number' ? posted.attempt : 0;
    if (path === '/api/recognize' && script.cloud) {
      recognizeAttempts.push(attempt);
      return script.cloud(attempt);
    }
    if (path === '/api/recognize-independent' && script.independent) {
      independentAttempts.push(attempt);
      return script.independent(attempt);
    }
    if (path.startsWith('/api/card?')) {
      const printingId = new URL(path, 'https://keeper.test').searchParams.get('printing');
      const record = preservedPrintings.find((entry) => entry.id === printingId);
      return { cards: record ? [record] : [] };
    }
    throw new Error(`The transport stub received an unexpected request: ${path}`);
  };
  return { request, recognizeAttempts, independentAttempts };
}

function createPreservedRecognition(
  transport: Transport,
  options: { readonly cloudEnabled?: boolean } = {},
): Recognition<HTMLCanvasElement> {
  return createRecognition<HTMLCanvasElement>({
    createEnginePipeline: () =>
      createBrowserRecognitionPipeline({
        request: transport.request,
        cloudEnabled: options.cloudEnabled,
      }),
    catalog: createCatalogStub(catalogFixture),
    inspectFrame: () => frameFacts(),
  });
}

function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('preserved recognition pipeline', () => {
  let originalWorker: typeof Worker | undefined;
  let originalDocument: Document | undefined;

  beforeEach(() => {
    WorkerStub.instances = [];
    WorkerStub.result = (attempt) => serviceReading(attempt);
    WorkerStub.hold = Promise.resolve();
    // The preserved worker and the remote warm-up frame are the only browser environment the
    // composition needs; the engines themselves run for real.
    originalWorker = globalThis.Worker;
    originalDocument = globalThis.document;
    globalThis.Worker = WorkerStub as unknown as typeof Worker;
    globalThis.document = { createElement: () => createCanvas() } as unknown as Document;
  });

  afterEach(() => {
    if (originalWorker) {
      globalThis.Worker = originalWorker;
    } else {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    }
    if (originalDocument) {
      globalThis.document = originalDocument;
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  });

  it('delivers the preserved early reading beside its settled comparison', async () => {
    WorkerStub.result = (attempt) =>
      serviceReading(attempt, {
        candidates: [bolt],
        evidence: {
          topScore: 0.91,
          differentIdentityMargin: 0.2,
          visual: { cardPresence: { state: 'single' } },
          titleLanguage: 'en',
          identityTitleCorroborated: true,
          exactPrintingId: bolt.id,
        },
        versions: { visual: { adapter: 'collectorvision-browser', code: 'visual-1' } },
        timings: { detectMs: 3, totalMs: 9 },
      });
    const local = deferred<undefined>();
    const cloud = deferred<undefined>();
    const independent = deferred<undefined>();
    const remoteStarted = deferred<undefined>();
    WorkerStub.hold = local.promise;
    const transport = createTransport({
      cloud: (attempt) => {
        // The hybrid's hedge starts the remote comparison before the local read settles, as it
        // does whenever local inference outlasts the hedge delay.
        remoteStarted.resolve(undefined);
        return cloud.promise.then(() =>
          serviceReading(attempt, {
            candidates: [counterspell],
            evidence: { titleAgrees: false, visual: { cardPresence: { state: 'single' } } },
            versions: { visual: '1.2.0' },
            timings: { totalMs: 40 },
          }),
        );
      },
      independent: (attempt) =>
        independent.promise.then(() =>
          serviceReading(attempt, {
            candidates: [bolt],
            evidence: { independentIdentity: true, identityBasis: 'visible_title' },
          }),
        ),
    });
    const recognition = createPreservedRecognition(transport);
    await recognition.prepare(prepareRequest);

    const readings: RecognitionReading[] = [];
    const attempt = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: createCanvas(),
      onReading: (reading) => readings.push(reading),
    });
    await remoteStarted.promise;
    local.resolve(undefined);
    const initial = await attempt.initial;

    // The early local reading reaches the public contract with the preserved evidence, versions
    // and timings, and still announces the comparison that is running.
    expect(initial).toMatchObject({
      revision: 1,
      status: 'possible',
      provisional: true,
      disagreement: null,
      evidence: {
        printingId: bolt.id,
        titleLanguage: 'en',
        titleCorroborated: true,
        cardPresence: 'single',
      },
      versions: { 'visual.adapter': 'collectorvision-browser', 'visual.code': 'visual-1' },
    });
    expect(initial.timings).toMatchObject({ detectMs: 3 });
    expect(initial.suggestion).toEqual({
      candidateIndex: 0,
      printingId: bolt.id,
      basis: 'corroborated',
    });
    expect(initial.candidates).toEqual([
      { cardId: bolt.oracle_id, printingId: bolt.id, name: 'Lightning Bolt', score: null },
    ]);

    // The independent identity path answers later; the attempt completes with the settled
    // comparison, which keeps the competing identity instead of presenting the early card as sure.
    cloud.resolve(undefined);
    independent.resolve(undefined);
    await attempt.completion;
    const settled = readings.at(-1);
    expect(settled).toMatchObject({
      status: 'possible',
      provisional: false,
      disagreement: { cardIds: [bolt.oracle_id, counterspell.oracle_id] },
    });
    expect(settled?.candidates.map((candidate) => candidate.printingId)).toEqual([
      bolt.id,
      counterspell.id,
    ]);
    // Every reading of the attempt was delivered once, in order, and the early reading stands.
    expect([initial, ...readings].map((reading) => reading.revision)).toEqual([1, 2, 3]);
    expect(initial.candidates.map((candidate) => candidate.printingId)).toEqual([bolt.id]);

    recognition.dispose({ sessionId: 'session-1' });
  });

  it('keeps the preserved independent session call limit', async () => {
    const transport = createTransport({
      cloud: (attempt) =>
        serviceReading(attempt, { candidates: [bolt], evidence: { titleAgrees: false } }),
      independent: (attempt) =>
        serviceReading(attempt, {
          candidates: [counterspell],
          evidence: { independentIdentity: true, identityBasis: 'visible_title' },
        }),
    });
    const recognition = createPreservedRecognition(transport);
    await recognition.prepare(prepareRequest);

    // The retained session budget is fifty independent requests; each capture spends one.
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const read = recognition.recognize({
        ...prepareRequest,
        captureId: `capture-${attempt}`,
        attempt,
        frame: createCanvas(),
      });
      await read.initial;
      await read.completion;
    }
    expect(transport.independentAttempts).toHaveLength(50);

    const beyond = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-51',
      attempt: 51,
      frame: createCanvas(),
    });
    await expect(beyond.initial).resolves.toMatchObject({ status: 'possible' });
    await beyond.completion;
    expect(transport.independentAttempts).toHaveLength(50);

    recognition.dispose({ sessionId: 'session-1' });
  });

  it('runs the local ONNX engine alone when the remote comparison is disabled', async () => {
    WorkerStub.result = (attempt) =>
      serviceReading(attempt, {
        candidates: [bolt],
        evidence: { topScore: 0.9, visual: { cardPresence: { state: 'single' } } },
      });
    const transport = createTransport({});
    const recognition = createPreservedRecognition(transport, { cloudEnabled: false });
    await recognition.prepare(prepareRequest);

    const attempt = recognition.recognize({
      ...prepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: createCanvas(),
    });
    await expect(attempt.initial).resolves.toMatchObject({
      status: 'possible',
      provisional: false,
      candidates: [
        { cardId: bolt.oracle_id, printingId: bolt.id, name: 'Lightning Bolt', score: null },
      ],
    });
    await attempt.completion;

    // The composed session never reaches the remote endpoints.
    expect(transport.recognizeAttempts).toEqual([]);
    expect(transport.independentAttempts).toEqual([]);

    recognition.dispose({ sessionId: 'session-1' });
  });
});
