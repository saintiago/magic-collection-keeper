/**
 * Component scope: the component-owned adapter from the preserved browser/Python engines to the
 * public pipeline port (docs/recognition.md#interface, docs/recognition.md#engines-and-assets).
 * The preserved browser, backend, hybrid, race and independent modules run for real behind stubbed
 * browser globals and an authenticated request stub, so candidate interpretation, the late hybrid
 * comparison, the independent session call limit and the local-only composition are verified
 * through the public lifecycle (docs/testing.md).
 */

import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createBrowserRecognitionPipeline,
  createRecognition,
  recognitionEngineNames,
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
const spanishBolt: PreservedPrinting = {
  ...bolt,
  id: '00000000-0000-4000-8000-000000000103',
  lang: 'es',
};
const preservedPrintings = [bolt, counterspell, spanishBolt];

/** The same identities as the published Catalog the component validates readings against. */
const catalogFixture: CatalogFixture = {
  cards: [card(bolt.oracle_id, bolt.name), card(counterspell.oracle_id, counterspell.name)],
  printings: [
    printing(bolt.id, bolt.oracle_id, bolt.collector_number, bolt.set),
    printing(spanishBolt.id, bolt.oracle_id, bolt.collector_number, bolt.set),
    printing(
      counterspell.id,
      counterspell.oracle_id,
      counterspell.collector_number,
      counterspell.set,
    ),
  ],
};

const prepareRequest = {
  sessionId: 'session-1',
  engines: ['browser-onnx', 'python-ocr', 'independent-identity'],
} as const;
const localPrepareRequest = { ...prepareRequest, engines: ['browser-onnx'] } as const;

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
  /** The card state the preserved browser geometry check reports for one frame. */
  static geometryState = 'single';
  /** Whether the preserved browser geometry check fails to prepare or to inspect a frame. */
  static failGeometry = false;
  /** Holds frame results back so a case can control which engine answers first. */
  static hold: Promise<void> = Promise.resolve();
  static failPreparation = false;
  static failRecognition = false;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  /** True for the preserved geometry check's worker, which inspects frames without an attempt. */
  readonly geometry: boolean;

  constructor(url?: unknown) {
    this.geometry = String(url ?? '').includes('card-presence-worker');
    WorkerStub.instances.push(this);
  }

  postMessage(message: unknown): void {
    const posted = message as { type: string; attempt?: number };
    if (posted.type === 'init') {
      queueMicrotask(() =>
        this.emit(
          (this.geometry ? WorkerStub.failGeometry : WorkerStub.failPreparation)
            ? { type: 'error', message: 'Worker preparation failed' }
            : { type: 'ready', metrics: { prepareMs: 1 } },
        ),
      );
    }
    if (posted.type === 'frame') {
      if (this.geometry) {
        // The preserved geometry check inspects a frame without an attempt identity; the visual
        // worker always reports the attempt it reads for.
        queueMicrotask(() =>
          this.emit(
            WorkerStub.failGeometry
              ? { type: 'error', message: 'Card geometry check unavailable' }
              : { type: 'result', result: { state: WorkerStub.geometryState, elapsedMs: 1 } },
          ),
        );
        return;
      }
      const attempt = posted.attempt ?? 0;
      void WorkerStub.hold.then(() =>
        this.emit(
          WorkerStub.failRecognition
            ? { type: 'error', message: 'Worker inference failed' }
            : { type: 'result', result: WorkerStub.result(attempt) },
        ),
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
      drawImage: () => {},
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
  readonly translated?: readonly PreservedPrinting[];
  readonly cloud?: (attempt: number) => unknown | Promise<unknown>;
  readonly independent?: (attempt: number) => unknown | Promise<unknown>;
}

interface Transport {
  readonly request: PreservedRequest;
  readonly paths: readonly string[];
  readonly recognizeAttempts: readonly number[];
  readonly independentAttempts: readonly number[];
}

/** One authenticated transport stub serving the preserved endpoints and Catalog hydration. */
function createTransport(script: TransportScript): Transport {
  const paths: string[] = [];
  const recognizeAttempts: number[] = [];
  const independentAttempts: number[] = [];
  const request: PreservedRequest = async (path, init) => {
    paths.push(path);
    if (path.startsWith('/api/search?')) return { cards: script.translated ?? [] };
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
  return { request, paths, recognizeAttempts, independentAttempts };
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

/** Actual retained service envelopes, with controlled providers and no live model calls. */
function pythonServiceReadings(): Record<string, Record<string, unknown>> {
  return JSON.parse(
    execFileSync(
      process.env['KEEPER_PYTHON'] ?? 'python3',
      [
        '-c',
        `
import json, sys
sys.path.insert(0, "src/recognition/python")
from service import RecognitionService
from independent_service import IndependentRecognitionService
printing = json.load(sys.stdin)
class Broken:
    version = {"adapter": "controlled-failure"}
    def inspect(self, image):
        raise RuntimeError("private provider detail")
    def read(self, *args):
        raise RuntimeError("private provider detail")
class Visual:
    version = {"adapter": "controlled-visual"}
    def __init__(self, supported):
        self.supported = supported
    def inspect(self, image):
        return {"identity_supported": self.supported, "candidates": [printing]}
class Unknown:
    version = {"adapter": "controlled-unknown"}
    def read(self, image):
        return {"uncertain": True}
def independent(reader):
    return IndependentRecognitionService(reader, lambda image: {"state": "single"}, {}, {}).recognize(None)
print(json.dumps({
    "visualUnavailable": RecognitionService(Broken(), Broken()).recognize(None),
    "independentUnavailable": independent(Broken()),
    "visualUnknown": RecognitionService(Visual(False), Broken()).recognize(None),
    "independentUnknown": independent(Unknown()),
    "ocrUnavailable": RecognitionService(Visual(True), Broken()).recognize(None),
}))
`,
      ],
      { input: JSON.stringify(bolt), encoding: 'utf8' },
    ),
  ) as Record<string, Record<string, unknown>>;
}

describe('preserved recognition pipeline', () => {
  let originalWorker: typeof Worker | undefined;
  let originalDocument: Document | undefined;

  beforeEach(() => {
    WorkerStub.instances = [];
    WorkerStub.result = (attempt) => serviceReading(attempt);
    WorkerStub.geometryState = 'single';
    WorkerStub.failGeometry = false;
    WorkerStub.hold = Promise.resolve();
    WorkerStub.failPreparation = false;
    WorkerStub.failRecognition = false;
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

  it.each(['visualUnavailable', 'independentUnavailable', 'both', 'throwing'])(
    'reports unavailable when all inference paths fail (%s)',
    async (failure) => {
      const responses = pythonServiceReadings();
      expect(responses['visualUnavailable']).toMatchObject({ reason: 'visual_unavailable' });
      expect(responses['independentUnavailable']).toMatchObject({
        evidence: { independentUnavailable: true },
      });
      WorkerStub.failRecognition = true;
      const transport = createTransport({
        cloud: (attempt) => {
          if (attempt === 100000) return serviceReading(attempt);
          if (failure === 'visualUnavailable' || failure === 'both')
            return { ...responses['visualUnavailable'], attempt };
          throw new Error('Visual service unavailable');
        },
        independent: (attempt) => {
          if (failure === 'independentUnavailable' || failure === 'both')
            return { ...responses['independentUnavailable'], attempt };
          throw new Error('Independent service unavailable');
        },
      });
      const recognition = createPreservedRecognition(transport);
      try {
        await recognition.prepare(prepareRequest);
        const readings: RecognitionReading[] = [];
        const attempt = recognition.recognize({
          ...prepareRequest,
          captureId: 'capture-1',
          attempt: 1,
          frame: createCanvas(),
          onReading: (reading) => readings.push(reading),
        });
        await expect(attempt.initial).rejects.toMatchObject({ code: 'unavailable' });
        await attempt.completion;
        expect(readings).toEqual([]);
        expect(transport.recognizeAttempts).toContain(1);
        expect(transport.independentAttempts).toEqual([1]);
      } finally {
        recognition.dispose({ sessionId: 'session-1' });
      }
    },
  );

  it('rejects failed remote warm-up after local preparation fails and permits retry', async () => {
    const responses = pythonServiceReadings();
    WorkerStub.failPreparation = true;
    let remoteFailed = true;
    const transport = createTransport({
      cloud: (attempt) =>
        remoteFailed
          ? { ...responses['visualUnavailable'], attempt }
          : serviceReading(attempt, { candidates: [bolt] }),
    });
    const recognition = createPreservedRecognition(transport);
    try {
      await expect(recognition.prepare(prepareRequest)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(WorkerStub.instances.every((worker) => worker.terminated)).toBe(true);
      expect(transport.recognizeAttempts).toEqual([100000]);
      remoteFailed = false;
      await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject(prepareRequest);
      const attempt = recognition.recognize({
        ...prepareRequest,
        captureId: 'capture-retry',
        attempt: 1,
        frame: createCanvas(),
      });
      await expect(attempt.initial).resolves.toMatchObject({
        status: 'possible',
        candidates: [{ printingId: bolt.id }],
      });
      await attempt.completion;
    } finally {
      recognition.dispose({ sessionId: 'session-1' });
    }
  });

  it.each([
    { succeeds: 'local', expected: 'possible' },
    { succeeds: 'visual', expected: 'possible' },
    { succeeds: 'independent', expected: 'possible' },
    { succeeds: 'localUnknown', expected: 'unknown' },
    { succeeds: 'visualUnknown', expected: 'unknown' },
    { succeeds: 'independentUnknown', expected: 'unknown' },
    { succeeds: 'ocrUnavailable', expected: 'possible' },
  ])('preserves $succeeds when other paths fail', async ({ succeeds, expected }) => {
    const responses = pythonServiceReadings();
    WorkerStub.failRecognition = !['local', 'localUnknown'].includes(succeeds);
    WorkerStub.result = (attempt) =>
      serviceReading(attempt, { candidates: succeeds === 'local' ? [bolt] : [] });
    const transport = createTransport({
      cloud: (attempt) => {
        if (attempt === 100000) return serviceReading(attempt);
        if (succeeds === 'visual') return serviceReading(attempt, { candidates: [bolt] });
        return {
          ...responses[
            ['visualUnknown', 'ocrUnavailable'].includes(succeeds) ? succeeds : 'visualUnavailable'
          ],
          attempt,
        };
      },
      independent: (attempt) =>
        succeeds === 'independent'
          ? serviceReading(attempt, { candidates: [bolt] })
          : {
              ...responses[succeeds === 'independentUnknown' ? succeeds : 'independentUnavailable'],
              attempt,
            },
    });
    const recognition = createPreservedRecognition(transport);
    try {
      await recognition.prepare(prepareRequest);
      const readings: RecognitionReading[] = [];
      const attempt = recognition.recognize({
        ...prepareRequest,
        captureId: 'capture-1',
        attempt: 1,
        frame: createCanvas(),
        onReading: (reading) => readings.push(reading),
      });
      const initial = await attempt.initial;
      await attempt.completion;
      for (const reading of [initial, ...readings]) {
        expect(reading.status).toBe(expected);
        expect(reading.candidates.map((candidate) => candidate.printingId)).toEqual(
          expected === 'possible' ? [bolt.id] : [],
        );
      }
      expect(readings.at(-1)?.provisional ?? initial.provisional).toBe(false);
    } finally {
      recognition.dispose({ sessionId: 'session-1' });
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
    await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject(prepareRequest);

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

  it('awaits a pending hybrid comparison after the independent engine returned unknown', async () => {
    const local = deferred<undefined>();
    const cloud = deferred<undefined>();
    const cloudStarted = deferred<undefined>();
    WorkerStub.hold = local.promise;
    WorkerStub.result = (attempt) => serviceReading(attempt, { candidates: [bolt] });
    const transport = createTransport({
      independent: (attempt) => serviceReading(attempt),
      cloud: async (attempt) => {
        if (attempt === 100000) return serviceReading(attempt);
        cloudStarted.resolve(undefined);
        await cloud.promise;
        return serviceReading(attempt, { candidates: [counterspell] });
      },
    });
    const recognition = createPreservedRecognition(transport);
    try {
      await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject(prepareRequest);
      const readings: RecognitionReading[] = [];
      const attempt = recognition.recognize({
        sessionId: 'session-1',
        captureId: 'capture-1',
        attempt: 1,
        frame: createCanvas(),
        onReading: (reading) => readings.push(reading),
      });
      let completed = false;
      void attempt.completion.then(() => {
        completed = true;
      });
      await cloudStarted.promise;
      local.resolve(undefined);
      const initial = await attempt.initial;
      expect(initial).toMatchObject({ provisional: true, candidates: [{ printingId: bolt.id }] });
      await expect(
        recognition.recognize({
          sessionId: 'session-1',
          captureId: 'capture-2',
          attempt: 2,
          frame: createCanvas(),
        }).initial,
      ).rejects.toMatchObject({ code: 'busy' });
      expect(completed).toBe(false);
      cloud.resolve(undefined);
      await attempt.completion;
      expect(readings.at(-1)).toMatchObject({
        provisional: false,
        disagreement: { cardIds: [bolt.oracle_id, counterspell.oracle_id] },
      });
      expect([initial, ...readings].map((reading) => reading.identity)).toEqual([
        { sessionId: 'session-1', captureId: 'capture-1', attempt: 1 },
        { sessionId: 'session-1', captureId: 'capture-1', attempt: 1 },
      ]);
    } finally {
      recognition.dispose({ sessionId: 'session-1' });
      local.resolve(undefined);
      cloud.resolve(undefined);
    }
  });

  it.each([
    { language: 'es', translated: [spanishBolt], expected: spanishBolt, basis: 'representative' },
    { language: 'es', translated: [], expected: bolt, basis: 'representative' },
    { language: 'en', translated: [], expected: bolt, basis: 'corroborated' },
  ])(
    'preserves $language printing uncertainty with hydration to $expected.lang ($basis)',
    async ({ language, translated, expected, basis }) => {
      // Run the retained producer: a Spanish footer corroborates the English record only as a
      // translation reference; the English title/footer case instead has an exact printing ID.
      const policy = JSON.parse(
        execFileSync(
          process.env['KEEPER_PYTHON'] ?? 'python3',
          [
            '-c',
            `
import json, sys
from src.recognition.python.policy import decide
printing, language = json.load(sys.stdin)
visual = {"candidates": [printing], "identity_supported": True}
text = {"title": ["Relampago" if language == "es" else "Lightning Bolt"],
        "footer": ["149 M11 " + ("SP" if language == "es" else "EN")]}
print(json.dumps(decide(visual, text, aliases=[("Relampago", "es")])))
`,
          ],
          { input: JSON.stringify([bolt, language]), encoding: 'utf8' },
        ),
      ) as Record<string, unknown>;
      expect(policy['evidence']).toMatchObject({
        titleLanguage: language,
        printingReferenceId: bolt.id,
        exactPrintingCorroborated: language === 'en',
      });
      const transport = createTransport({ translated });
      WorkerStub.result = (attempt) => ({ ...policy, attempt });
      const recognition = createPreservedRecognition(transport, { cloudEnabled: false });
      try {
        await recognition.prepare(localPrepareRequest);
        const attempt = recognition.recognize({
          sessionId: 'session-1',
          captureId: 'capture-1',
          attempt: 1,
          frame: createCanvas(),
        });
        const reading = await attempt.initial;
        await attempt.completion;
        expect(reading.candidates.map((candidate) => candidate.printingId)).toEqual([expected.id]);
        expect(reading.suggestion).toMatchObject({ printingId: expected.id, basis });
        expect(reading.evidence.printingId).toBe(language === 'en' ? bolt.id : null);
        expect(reading.evidence.titleLanguage).toBe(language);
        if (language === 'es')
          expect(transport.paths.some((path) => path.startsWith('/api/search?'))).toBe(true);
      } finally {
        recognition.dispose({ sessionId: 'session-1' });
      }
    },
  );

  it.each([
    { cloudEnabled: true, engines: ['browser-onnx'] },
    { cloudEnabled: false, engines: prepareRequest.engines },
    { cloudEnabled: true, engines: ['browser-onnx', 'python-ocr'] },
    { cloudEnabled: false, engines: ['unsupported'] },
  ])(
    'rejects a mismatched engine selection before preparation: $engines / cloud=$cloudEnabled',
    async ({ cloudEnabled, engines }) => {
      const transport = createTransport({});
      const recognition = createPreservedRecognition(transport, { cloudEnabled });
      try {
        await expect(
          recognition.prepare({ sessionId: 'session-1', engines }),
        ).rejects.toMatchObject({ code: 'invalid-request' });
        expect(WorkerStub.instances).toHaveLength(0);
        expect(transport.paths).toEqual([]);
        await expect(
          recognition.recognize({
            sessionId: 'session-1',
            captureId: 'capture-1',
            attempt: 1,
            frame: createCanvas(),
          }).initial,
        ).rejects.toMatchObject({ code: 'invalid-request' });
      } finally {
        recognition.dispose({ sessionId: 'session-1' });
      }
    },
  );

  it.each([
    { cloudEnabled: true, engines: ['browser-onnx', 'python-ocr', 'independent-identity'] },
    { cloudEnabled: false, engines: ['browser-onnx'] },
  ])(
    'names the engines one capability enables and prepares exactly those: $engines',
    async ({ cloudEnabled, engines }) => {
      expect(recognitionEngineNames(cloudEnabled)).toEqual(engines);
      const transport = createTransport({});
      const recognition = createPreservedRecognition(transport, { cloudEnabled });
      try {
        await expect(
          recognition.prepare({
            sessionId: 'session-1',
            engines: recognitionEngineNames(cloudEnabled),
          }),
        ).resolves.toMatchObject({ engines });
      } finally {
        recognition.dispose({ sessionId: 'session-1' });
      }
    },
  );

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
    await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject(prepareRequest);

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
    // The preserved browser worker reports a card where its quadrilateral check found one, but no
    // card count; the component's geometry check establishes it for the frame it read.
    WorkerStub.result = (attempt) =>
      serviceReading(attempt, { candidates: [bolt], evidence: { topScore: 0.9 } });
    const transport = createTransport({});
    const recognition = createPreservedRecognition(transport, { cloudEnabled: false });
    await expect(recognition.prepare(localPrepareRequest)).resolves.toMatchObject(
      localPrepareRequest,
    );

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
      evidence: { cardPresence: 'single' },
    });
    await attempt.completion;

    // The composed session never reaches the remote endpoints.
    expect(transport.recognizeAttempts).toEqual([]);
    expect(transport.independentAttempts).toEqual([]);

    recognition.dispose({ sessionId: 'session-1' });
  });

  it('keeps a browser-only identity unknown while the frame does not hold one card', async () => {
    WorkerStub.result = (attempt) => serviceReading(attempt, { candidates: [bolt] });
    WorkerStub.geometryState = 'multiple';
    const transport = createTransport({});
    const recognition = createPreservedRecognition(transport, { cloudEnabled: false });
    await expect(recognition.prepare(localPrepareRequest)).resolves.toMatchObject(
      localPrepareRequest,
    );
    const attempt = recognition.recognize({
      ...localPrepareRequest,
      captureId: 'capture-1',
      attempt: 1,
      frame: createCanvas(),
    });

    // Geometry decides independently of the identity the engine matched, and the reading keeps the
    // geometry it was denied by instead of presenting a candidate.
    await expect(attempt.initial).resolves.toMatchObject({
      status: 'unknown',
      candidates: [],
      evidence: { cardPresence: 'multiple' },
    });
    await attempt.completion;
    recognition.dispose({ sessionId: 'session-1' });
  });

  it('leaves a frame without geometry unadmitted when the browser check cannot report one', async () => {
    WorkerStub.result = (attempt) => serviceReading(attempt, { candidates: [bolt] });
    WorkerStub.failGeometry = true;
    const transport = createTransport({});
    const recognition = createPreservedRecognition(transport, { cloudEnabled: false });
    try {
      // A runtime whose geometry check cannot run still prepares its engines, and the frame it
      // cannot establish admits nothing instead of presenting the candidate it matched.
      await expect(recognition.prepare(localPrepareRequest)).resolves.toMatchObject(
        localPrepareRequest,
      );
      const attempt = recognition.recognize({
        ...localPrepareRequest,
        captureId: 'capture-1',
        attempt: 1,
        frame: createCanvas(),
      });
      await expect(attempt.initial).resolves.toMatchObject({
        status: 'unknown',
        candidates: [],
        evidence: { cardPresence: null },
      });
      await attempt.completion;
    } finally {
      recognition.dispose({ sessionId: 'session-1' });
    }
  });

  it('keeps a reading that reports its own geometry when the browser check fails', async () => {
    WorkerStub.failGeometry = true;
    const transport = createTransport({
      cloud: (attempt) =>
        serviceReading(attempt, {
          candidates: [bolt],
          evidence: { titleAgrees: false, visual: { cardPresence: { state: 'single' } } },
        }),
    });
    const recognition = createPreservedRecognition(transport);
    try {
      await expect(recognition.prepare(prepareRequest)).resolves.toMatchObject(prepareRequest);
      const attempt = recognition.recognize({
        ...prepareRequest,
        captureId: 'capture-1',
        attempt: 1,
        frame: createCanvas(),
      });

      // The remote path establishes the frame's geometry itself, so the cloud runtime keeps
      // admitting cards without the browser check.
      await expect(attempt.initial).resolves.toMatchObject({
        status: 'possible',
        candidates: [{ printingId: bolt.id }],
        evidence: { cardPresence: 'single' },
      });
      await attempt.completion;
    } finally {
      recognition.dispose({ sessionId: 'session-1' });
    }
  });
});
