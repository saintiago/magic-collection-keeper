/**
 * Helpers shared by the Recognition component cases: a controlled engine pipeline, a Catalog
 * substitute over a declared fixture and bounded frame facts, so the public contract runs with
 * real request validation and real candidate mapping.
 */

import type {
  CardRecord,
  CatalogReference,
  CatalogResolution,
  CatalogRevision,
  PrintingRecord,
} from '../../../src/catalog/index.js';
import {
  createRecognition,
  type Recognition,
  type RecognitionCatalogPort,
  type RecognitionEngineOutcome,
  type RecognitionEnginePipeline,
  type RecognitionEnginePreparation,
  type RecognitionEnginePrepareRequest,
  type RecognitionEngineRecognizeRequest,
  type RecognitionFrameFacts,
} from '../../../src/recognition/index.js';

export interface CatalogFixture {
  readonly cards: readonly CardRecord[];
  readonly printings: readonly PrintingRecord[];
}

/** Basic card information with no translated names or optional facts. */
export function card(cardId: string, name: string): CardRecord {
  return {
    cardId,
    name,
    names: [{ language: 'en', name }],
    rulesText: null,
    typeLine: null,
    colors: [],
    colorIdentity: [],
    manaValue: null,
  };
}

/** One regular paper printing of a card. */
export function printing(
  printingId: string,
  cardId: string,
  collectorNumber: string,
  edition = 'TST',
): PrintingRecord {
  return {
    printingId,
    cardId,
    edition,
    collectorNumber,
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: { small: null, normal: null, large: null, artCrop: null },
  };
}

const revision: CatalogRevision = {
  revisionId: 'catalog-revision-1',
  sourceName: 'fixture',
  sourceVersion: 'fixture-1',
  publishedAt: '2026-09-26T00:00:00.000Z',
};

/** Resolves exactly the declared fixture records, recording every requested batch. */
export function createCatalogStub(
  fixture: CatalogFixture,
  calls: CatalogReference[][] = [],
): RecognitionCatalogPort {
  return {
    async resolve(references: readonly CatalogReference[]): Promise<CatalogResolution> {
      calls.push([...references]);
      const wanted = new Set(
        references.map((reference) =>
          reference.kind === 'card'
            ? `card:${reference.cardId}`
            : `printing:${reference.printingId}`,
        ),
      );
      const cards = new Map(
        fixture.cards
          .filter((record) => wanted.has(`card:${record.cardId}`))
          .map((record) => [record.cardId, record] as const),
      );
      const printings = new Map(
        fixture.printings
          .filter((record) => wanted.has(`printing:${record.printingId}`))
          .map((record) => [record.printingId, record] as const),
      );
      const missing = references.filter((reference) =>
        reference.kind === 'card'
          ? !cards.has(reference.cardId)
          : !printings.has(reference.printingId),
      );
      return { revision, cards, printings, missing };
    },
  };
}

/** Bounded facts of a valid captured frame; overrides declare invalid input explicitly. */
export function frameFacts(overrides: Partial<RecognitionFrameFacts> = {}): RecognitionFrameFacts {
  return { width: 400, height: 560, format: 'jpeg', encodedBytes: 2048, ...overrides };
}

/** One raw pipeline outcome; each test overrides the field under assertion. */
export function outcome(
  overrides: Partial<RecognitionEngineOutcome> = {},
): RecognitionEngineOutcome {
  return {
    status: 'unknown',
    candidates: [],
    evidence: {
      printingId: null,
      titleLanguage: null,
      titleCorroborated: false,
      cardPresence: 'single',
    },
    provisional: false,
    versions: {},
    timings: {},
    ...overrides,
  };
}

export interface PipelineStub {
  readonly pipeline: RecognitionEnginePipeline<string>;
  readonly state: {
    prepare: (request: RecognitionEnginePrepareRequest) => Promise<RecognitionEnginePreparation>;
    recognize: (
      frame: string,
      request: RecognitionEngineRecognizeRequest,
    ) => Promise<RecognitionEngineOutcome>;
    readonly prepareCalls: RecognitionEnginePrepareRequest[];
    readonly recognizeCalls: RecognitionEngineRecognizeRequest[];
    disposals: number;
  };
}

export function createPipelineStub(): PipelineStub {
  const state: PipelineStub['state'] = {
    prepare: async () => ({}),
    recognize: async () => outcome(),
    prepareCalls: [],
    recognizeCalls: [],
    disposals: 0,
  };
  const pipeline: RecognitionEnginePipeline<string> = {
    prepare(request) {
      state.prepareCalls.push(request);
      return state.prepare(request);
    },
    recognize(frame, request) {
      state.recognizeCalls.push(request);
      return state.recognize(frame, request);
    },
    dispose() {
      state.disposals += 1;
    },
  };
  return { pipeline, state };
}

export interface RecognitionHarness {
  readonly recognition: Recognition<string>;
  /** One pipeline per prepared session, in creation order. */
  readonly pipelines: readonly PipelineStub[];
  /** Every catalog resolution batch, in call order. */
  readonly catalogCalls: readonly CatalogReference[][];
  /** The pipeline of the most recently prepared session. */
  current(): PipelineStub;
}

export interface RecognitionHarnessOptions {
  readonly fixture?: CatalogFixture;
  readonly inspectFrame?: (frame: string) => RecognitionFrameFacts | null;
  /** Adjusts a fresh pipeline stub before the component uses it. */
  readonly configurePipeline?: (stub: PipelineStub) => void;
}

export function createRecognitionHarness(
  options: RecognitionHarnessOptions = {},
): RecognitionHarness {
  const pipelines: PipelineStub[] = [];
  const catalogCalls: CatalogReference[][] = [];
  const recognition = createRecognition<string>({
    createEnginePipeline: () => {
      const stub = createPipelineStub();
      pipelines.push(stub);
      options.configurePipeline?.(stub);
      return stub.pipeline;
    },
    catalog: createCatalogStub(options.fixture ?? { cards: [], printings: [] }, catalogCalls),
    inspectFrame:
      options.inspectFrame ?? ((frame) => (frame === 'unreadable' ? null : frameFacts())),
  });
  return {
    recognition,
    pipelines,
    catalogCalls,
    current() {
      const stub = pipelines.at(-1);
      if (!stub) {
        throw new Error('No engine pipeline has been created yet.');
      }
      return stub;
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

/** Lets pending microtasks and immediate callbacks settle without a fixed sleep. */
export function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Caller input as an untyped transport could send it, so validation is exercised for real. */
export function callerInput<T>(value: unknown): T {
  return value as T;
}
