import {
  RECOGNITION_LIMITS,
  recognitionCardPresenceStates,
  type RecognitionCardPresence,
  type RecognitionEngineCandidate,
  type RecognitionEngineName,
  type RecognitionEngineOutcome,
} from './model.js';
import type { RecognitionEnginePipeline, RecognitionEngineRecognizeRequest } from './service.js';
import { RecognitionError } from './errors.js';

import { createBackendRecognition } from '../browser/backend-recognition.js';
import { createBrowserRecognition } from '../browser/browser-recognition.js';
import { createHybridRecognition } from '../browser/hybrid-recognition.js';
import { createIndependentRecognition } from '../browser/independent-recognition.js';

/**
 * Component-owned adapter from the preserved browser/Python engines to the public pipeline port
 * (docs/recognition.md#interface, docs/recognition.md#engines-and-assets).
 *
 * `createBrowserRecognitionPipeline` composes the retained engines exactly as the pinned revision
 * did — the browser ONNX port, the remote visual/OCR port, the hybrid early/later comparison and
 * the independent identity path with its session call limit and at most one request in flight —
 * and translates their readings (candidate `id`/`oracle_id`, `measurement` evidence, versions and
 * timings, the early reading beside its comparison) into this component's engine outcome. The
 * engines stay byte-identical: the imported modules keep their behaviour and this file owns only
 * the shape and lifecycle translation.
 */

/** One authenticated request the preserved engines perform; Application supplies the transport. */
export interface PreservedRequest {
  (
    path: string,
    init: {
      readonly method?: string;
      readonly body?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

/** One reading as a preserved browser/Python engine reports it. */
export interface PreservedEngineReading {
  readonly status?: unknown;
  readonly candidates?: unknown;
  readonly evidence?: unknown;
  readonly versions?: unknown;
  readonly timings?: unknown;
  readonly measurement?: unknown;
  readonly provisional?: unknown;
  readonly completion?: unknown;
}

/** One progress report a preserved engine emits while it infers. */
export interface PreservedEngineStage {
  readonly stage: string;
  readonly active: boolean;
}

/** Options one preserved engine `recognize` call receives. */
export interface PreservedEngineRecognizeOptions {
  readonly signal?: AbortSignal;
  readonly attempt: number;
  readonly onUpdate?: (reading: PreservedEngineReading) => void;
  readonly onStage?: (stage: PreservedEngineStage) => void;
}

/** The port shape every preserved browser/Python engine exposes. */
export interface PreservedEnginePort<Frame> {
  prepare(): Promise<unknown>;
  recognize(
    frame: Frame,
    options: PreservedEngineRecognizeOptions,
  ): Promise<PreservedEngineReading>;
  dispose?(): void;
}

export interface BrowserRecognitionPipelineOptions {
  /** Authenticated request contract the preserved engines call (docs/application.md#interface). */
  readonly request: PreservedRequest;
  /**
   * Keeps the hybrid's remote comparison and the independent identity path. `false` runs the
   * local ONNX engine alone, as the pinned revision did when the remote path was disabled.
   * Prepare must request `browser-onnx`, `python-ocr` and `independent-identity` when enabled,
   * or only `browser-onnx` when disabled. Other engine sets are rejected before preparation.
   */
  readonly cloudEnabled?: boolean;
}

/**
 * Engine names the preserved pipeline enables for one runtime capability
 * (docs/recognition.md#interface, docs/recognition.md#engines-and-assets). A caller names exactly
 * these when it prepares a session: cloud inference runs the Python visual/OCR path and the
 * independent identity check beside the browser ONNX engine, while a local runtime runs the
 * browser engine alone. The selection lives here, with the composition that owns it, so
 * UserInterface prepares the same engines the pipeline accepts instead of repeating the names.
 */
export function recognitionEngineNames(cloudEnabled: boolean): readonly RecognitionEngineName[] {
  return cloudEnabled ? ['browser-onnx', 'python-ocr', 'independent-identity'] : ['browser-onnx'];
}

/**
 * Composes the preserved browser recognition into the public engine pipeline. The factory fixes
 * the composition of this session's engines: Application constructs it for the runtime's enabled
 * capabilities and supplies the authenticated transport, while the matching policy, candidate
 * interpretation and the independent session call limit stay with the preserved engines.
 */
export function createBrowserRecognitionPipeline(
  options: BrowserRecognitionPipelineOptions,
): RecognitionEnginePipeline<HTMLCanvasElement> {
  const request = options?.request;
  if (typeof request !== 'function') {
    throw new TypeError(
      'createBrowserRecognitionPipeline requires the authenticated request contract.',
    );
  }
  const cloudEnabled = options?.cloudEnabled !== false;
  const enabledEngines = recognitionEngineNames(cloudEnabled);
  const remoteRequest: PreservedRequest = async (path, init) => {
    const response = await request(path, init);
    if (path === '/api/recognize' || path === '/api/recognize-independent') {
      const reading = readRecord(response);
      // These retained Python envelopes mean inference failed, not an unresolved identity.
      // Reject before hydration drops the reason and composition treats them as successful
      // readings. The retained fallback/race then decides whether another engine succeeded;
      // this also covers the backend's preparation request through the same endpoints.
      if (
        reading?.status === 'unknown' &&
        (reading.reason === 'visual_unavailable' ||
          readRecord(reading.evidence)?.independentUnavailable === true)
      ) {
        throw new RecognitionError('unavailable', 'Recognition is unavailable. Please retry.');
      }
    }
    return response;
  };
  const primary = createHybridRecognition({
    local: createBrowserRecognition({ request }),
    cloud: cloudEnabled ? createBackendRecognition({ request: remoteRequest }) : null,
  });
  const engine = cloudEnabled
    ? createIndependentRecognition({
        primary,
        independent: createBackendRecognition({
          request: remoteRequest,
          endpoint: '/api/recognize-independent',
          provider: 'bedrock-independent',
        }),
      })
    : primary;

  return {
    async prepare({ engines }) {
      if (
        engines.length !== enabledEngines.length ||
        !enabledEngines.every((engine) => engines.includes(engine))
      ) {
        throw new RecognitionError(
          'invalid-request',
          `This pipeline requires the enabled engines: ${enabledEngines.join(', ')}.`,
        );
      }
      const ready = readRecord(await engine.prepare());
      return {
        versions: flattenReport(ready?.versions, readVersionEntry),
        timings: flattenReport(ready?.timings, readTimingEntry),
      };
    },
    recognize(frame, request) {
      return recognizeWithPreservedEngine(engine, frame, request);
    },
    dispose() {
      engine.dispose?.();
    },
  };
}

/**
 * Runs one attempt through a preserved composition. A hybrid resolves with the early reading
 * while its comparison is still running and reports later comparisons through `onUpdate`; this
 * port expects the returned outcome to be the attempt's last reading, so the early reading is
 * delivered immediately and each comparison is held back until a newer one — or the engine's
 * completion — can be returned after it (docs/recognition.md#execution).
 */
async function recognizeWithPreservedEngine<Frame>(
  engine: PreservedEnginePort<Frame>,
  frame: Frame,
  request: RecognitionEngineRecognizeRequest,
): Promise<RecognitionEngineOutcome> {
  let held: PreservedEngineReading | null = null;
  const result = await engine.recognize(frame, {
    signal: request.signal,
    attempt: request.attempt,
    onUpdate: (later) => {
      if (held) {
        request.onReading?.(toEngineOutcome(held, true));
      }
      held = later;
    },
  });
  const completion = readCompletion(result);
  if (completion === null) {
    // Nothing follows this reading: it is the outcome the component maps and delivers.
    return toEngineOutcome(result, false);
  }
  // The independent wrapper can clear its provisional flag while the nested hybrid comparison
  // is still pending. Only its completion establishes that no more updates can follow.
  request.onReading?.(toEngineOutcome(result, true));
  await completion;
  // Even an unknown/failed comparison must settle the early reading's provisional state.
  return toEngineOutcome(held ?? result, false);
}

/** Translates one preserved reading into this component's engine outcome. */
function toEngineOutcome(
  reading: PreservedEngineReading,
  provisional: boolean,
): RecognitionEngineOutcome {
  const measurement = readRecord(reading.measurement);
  const evidence = readRecord(measurement?.evidence) ?? readRecord(reading.evidence);
  return {
    status: reading.status === 'possible' ? 'possible' : 'unknown',
    candidates: readPreservedCandidates(reading.candidates),
    evidence: {
      // A translation reference is a lookup aid, not an exact identity. Hydration can choose
      // another language or fall back to the reference; neither establishes an exact printing ID.
      printingId: readText(evidence?.exactPrintingId),
      titleLanguage: readText(evidence?.titleLanguage),
      titleCorroborated:
        evidence?.identityTitleCorroborated === true || evidence?.titleAgrees === true,
      cardPresence: readCardPresence(evidence),
    },
    provisional,
    versions: flattenReport(measurement?.versions ?? reading.versions, readVersionEntry),
    timings: flattenReport(measurement?.processing ?? reading.timings, readTimingEntry),
  };
}

/**
 * The preserved resolution hydrates candidates into Catalog printing records (`id` and
 * `oracle_id`) and holds the whole-title evidence beside them; per-candidate similarity is not
 * part of its reading, so no candidate claims a score. The mapping boundary validates these
 * identities against the published Catalog (docs/recognition.md#interface).
 */
function readPreservedCandidates(value: unknown): readonly RecognitionEngineCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const candidate = readRecord(entry);
    return {
      cardId: readText(candidate?.oracle_id) ?? '',
      printingId: readText(candidate?.id) ?? '',
      name: readText(candidate?.name) ?? '',
      score: null,
    };
  });
}

function readCardPresence(
  evidence: Record<string, unknown> | null,
): RecognitionCardPresence | null {
  const visual = readRecord(evidence?.visual);
  const state = readRecord(visual?.cardPresence)?.state;
  return recognitionCardPresenceStates.find((known) => known === state) ?? null;
}

function readVersionEntry(entry: unknown): string | null {
  return typeof entry === 'string' && entry.length > 0 ? entry : null;
}

function readTimingEntry(entry: unknown): number | null {
  return typeof entry === 'number' && Number.isFinite(entry) ? entry : null;
}

/**
 * Flattens the preserved report (`{visual: {adapter, code}}`, `{detectMs: 3}`) into the bounded
 * flat map a reading retains, one nested level deep as the preserved manifests report it.
 */
function flattenReport<T>(value: unknown, read: (entry: unknown) => T | null): Record<string, T> {
  const report: Record<string, T> = {};
  const record = readRecord(value);
  if (!record) {
    return report;
  }
  for (const [key, entry] of Object.entries(record)) {
    if (Object.keys(report).length >= RECOGNITION_LIMITS.maxDiagnosticEntries) {
      break;
    }
    const nested = readRecord(entry);
    if (nested) {
      for (const [nestedKey, nestedEntry] of Object.entries(nested)) {
        if (Object.keys(report).length >= RECOGNITION_LIMITS.maxDiagnosticEntries) {
          break;
        }
        const kept = read(nestedEntry);
        if (kept !== null) {
          report[`${key}.${nestedKey}`] = kept;
        }
      }
      continue;
    }
    const kept = read(entry);
    if (kept !== null) {
      report[key] = kept;
    }
  }
  return report;
}

/** The completion a hybrid reports beside its early reading, or null when nothing follows. */
function readCompletion(reading: PreservedEngineReading): Promise<unknown> | null {
  const completion = reading.completion as { then?: unknown } | null | undefined;
  return completion && typeof completion === 'object' && typeof completion.then === 'function'
    ? (completion as Promise<unknown>)
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
