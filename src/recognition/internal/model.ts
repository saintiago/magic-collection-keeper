import type {
  CardId,
  CatalogReference,
  CatalogResolution,
  LanguageCode,
  PrintingId,
} from '../../catalog/index.js';

import { RecognitionError } from './errors.js';

/**
 * Candidate and lifecycle model of the Recognition component (docs/recognition.md#interface).
 *
 * A reading identifies its capture/attempt identity, status, ordered candidates, optional
 * suggestion, printing evidence, provisional state, disagreement, engine versions and timings.
 * A suggestion always belongs to the candidate set and stays distinguishable from an
 * evidence-supported printing, and no reading confers ownership or physical condition. Unknown
 * means no usable identity; invalid input, a busy session, cancellation and unavailable inference
 * are failures instead (docs/recognition.md#execution).
 */

/** Opaque session identity of one recognition lifecycle. */
export type RecognitionSessionId = string;

/** Opaque identity of one capture inside a session. */
export type RecognitionCaptureId = string;

/** Provider-owned engine identifier enabled for a session, for example `browser-onnx`. */
export type RecognitionEngineName = string;

/**
 * Bounds that keep recognition requests, inference and candidate response bounded
 * (docs/recognition.md#execution). Values the retained transport already enforces are kept.
 */
export const RECOGNITION_LIMITS = {
  /** Longest accepted opaque identifier, counted in JavaScript string units. */
  maxIdentifierLength: 200,
  /** Smallest accepted attempt identity. */
  minAttempt: 1,
  /** Largest accepted attempt identity. */
  maxAttempt: 100000,
  /** Largest accepted encoded frame in bytes. */
  maxImageBytes: 524288,
  /** Largest accepted decoded frame area. */
  maxImagePixels: 4000000,
  /** Smallest accepted decoded frame edge. */
  minImageDimension: 100,
  /** Longest candidate list a reading presents. */
  maxCandidates: 5,
  /** Longest enabled-engine selection one session prepares. */
  maxEngines: 8,
  /** Longest raw candidate list the mapping boundary accepts from a pipeline. */
  maxEngineCandidates: 20,
  /** Longest engine-reported display name retained for a raw candidate. */
  maxCandidateNameLength: 200,
  /** Longest version or timing report retained from a pipeline. */
  maxDiagnosticEntries: 32,
} as const;

export const recognitionStatuses = ['unknown', 'possible'] as const;
/** A reading either names usable candidate identities or reports no usable identity. */
export type RecognitionStatus = (typeof recognitionStatuses)[number];

export const recognitionCardPresenceStates = ['single', 'none', 'multiple', 'ambiguous'] as const;
/** Geometry of the captured frame, as reported by the pipeline. */
export type RecognitionCardPresence = (typeof recognitionCardPresenceStates)[number];

export const recognitionSuggestionBases = ['corroborated', 'representative'] as const;
/**
 * `corroborated` is backed by engine printing evidence; `representative` only ranks a printing as
 * the editable starting point of review and is never evidence of the observed edition.
 */
export type RecognitionSuggestionBasis = (typeof recognitionSuggestionBases)[number];

export const recognitionImageFormats = ['jpeg', 'png'] as const;
export type RecognitionImageFormat = (typeof recognitionImageFormats)[number];

/**
 * Bounded facts of the runtime frame that Recognition validates before inference
 * (docs/recognition.md#execution). The frame payload itself stays with the runtime; it never
 * reaches diagnostics or the public reading.
 */
export interface RecognitionFrameFacts {
  readonly width: number;
  readonly height: number;
  readonly format: RecognitionImageFormat;
  /** Encoded frame size in bytes, or null when the runtime only learns it while encoding. */
  readonly encodedBytes: number | null;
}

/** Capture identity of one reading: the session, the capture and the attempt inside it. */
export interface RecognitionIdentity {
  readonly sessionId: RecognitionSessionId;
  readonly captureId: RecognitionCaptureId;
  /** Integer attempt identity from `RECOGNITION_LIMITS.minAttempt` to `maxAttempt`. */
  readonly attempt: number;
}

/** Printing and capture evidence a reading retains; never ownership or physical condition. */
export interface RecognitionEvidence {
  /** Exact printing identity the pipeline corroborated, when it corroborated one. */
  readonly printingId: PrintingId | null;
  /** Language of the corroborated complete title, when the pipeline determined one. */
  readonly titleLanguage: LanguageCode | null;
  /** True when whole-title corroboration supported the reading. */
  readonly titleCorroborated: boolean;
  /** Geometry the pipeline reported, or null when it reported none. */
  readonly cardPresence: RecognitionCardPresence | null;
}

/**
 * One candidate identity of a reading. Identity and name are validated against the published
 * Catalog, which enriches the raw engine result without replacing printing evidence.
 */
export interface RecognitionCandidate {
  /** Playable identity, validated against the published Catalog. */
  readonly cardId: CardId;
  /** Exact printing identity, validated against the published Catalog. */
  readonly printingId: PrintingId;
  /** Canonical display name read from the published Catalog. */
  readonly name: string;
  /**
   * Engine similarity or self-confidence when the pipeline reports one; deliberately not a
   * calibrated probability and never compared across providers.
   */
  readonly score: number | null;
}

/** Editable printing suggestion that always belongs to the reading's candidate set. */
export interface RecognitionSuggestion {
  /** Index of the suggested candidate in the reading's ordered candidates. */
  readonly candidateIndex: number;
  /** Exact printing identity of the suggested candidate. */
  readonly printingId: PrintingId;
  readonly basis: RecognitionSuggestionBasis;
}

/** Competing playable identities retained instead of presenting one as certain. */
export interface RecognitionDisagreement {
  /** Distinct playable identities present in the ordered candidates, in candidate order. */
  readonly cardIds: readonly CardId[];
}

/** One delivered reading of an attempt. */
export interface RecognitionReading {
  readonly identity: RecognitionIdentity;
  /** Delivery sequence of this attempt; the initial reading is 1. */
  readonly revision: number;
  /** `possible` exactly when the candidate list is not empty. */
  readonly status: RecognitionStatus;
  /** Ordered candidate identities, most likely first; empty when the status is unknown. */
  readonly candidates: readonly RecognitionCandidate[];
  /** Editable suggestion, present exactly when the status is possible. */
  readonly suggestion: RecognitionSuggestion | null;
  readonly evidence: RecognitionEvidence;
  /** True while a later comparison for the same attempt may still deliver a reading. */
  readonly provisional: boolean;
  /** Competing identities of this reading, or null when the candidates agree. */
  readonly disagreement: RecognitionDisagreement | null;
  /** Engine and model versions that produced the reading, as reported by the pipeline. */
  readonly versions: Readonly<Record<string, string>>;
  /** Stage timings in milliseconds, as reported by the pipeline. */
  readonly timings: Readonly<Record<string, number>>;
}

/** Ready state of one prepared session. */
export interface RecognitionPreparation {
  readonly sessionId: RecognitionSessionId;
  /** The enabled engines the pipeline prepared for this session. */
  readonly engines: readonly RecognitionEngineName[];
  /** Engine and model versions reported while preparing, keyed by the pipeline's own names. */
  readonly versions: Readonly<Record<string, string>>;
  /** Preparation timings in milliseconds, as reported by the pipeline. */
  readonly timings: Readonly<Record<string, number>>;
}

/** One raw candidate of a pipeline outcome, behind the mapping boundary. */
export interface RecognitionEngineCandidate {
  /** Playable identity proposed by the engine. */
  readonly cardId: CardId;
  /** Exact printing identity proposed by the engine. */
  readonly printingId: PrintingId;
  /** Display name the engine read; not authoritative catalog data. */
  readonly name: string;
  /** Engine similarity or self-confidence, or null when the engine reports none. */
  readonly score: number | null;
}

/** Raw printing and geometry evidence of a pipeline outcome. */
export interface RecognitionEngineEvidence {
  /** Exact printing identity the engine corroborated, when it corroborated one. */
  readonly printingId: PrintingId | null;
  /** Language of the engine-corroborated complete title, when it determined one. */
  readonly titleLanguage: LanguageCode | null;
  /** True when whole-title corroboration supported the engine's leading candidate. */
  readonly titleCorroborated: boolean;
  /** Frame geometry the engine reported, or null when it reported none. */
  readonly cardPresence: RecognitionCardPresence | null;
}

/**
 * One raw pipeline outcome, preserved behind the mapping boundary
 * (docs/recognition.md#interface). Recognition maps it into a reading, catalog-validates the
 * candidate identities and never rewrites its evidence.
 */
export interface RecognitionEngineOutcome {
  readonly status: RecognitionStatus;
  readonly candidates: readonly RecognitionEngineCandidate[];
  readonly evidence: RecognitionEngineEvidence;
  /** True while the pipeline may still deliver a later comparison for the same attempt. */
  readonly provisional: boolean;
  readonly versions: Readonly<Record<string, string>>;
  readonly timings: Readonly<Record<string, number>>;
}

/** Catalog reads Recognition uses to validate candidates and resolve canonical printings. */
export interface RecognitionCatalogPort {
  resolve(references: readonly CatalogReference[]): Promise<CatalogResolution>;
}

/** Longest whitespace-free opaque identifier read from an untyped request. */
export function readIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > RECOGNITION_LIMITS.maxIdentifierLength ||
    /\s/u.test(value)
  ) {
    throw new RecognitionError(
      'invalid-request',
      `The ${label} must be a non-empty token of at most ${RECOGNITION_LIMITS.maxIdentifierLength} characters.`,
    );
  }
  return value;
}

/** Reads one capture identity from untyped caller input, or throws `invalid-request`. */
export function readIdentity(
  sessionId: unknown,
  captureId: unknown,
  attempt: unknown,
): RecognitionIdentity {
  const session = readIdentifier(sessionId, 'session identity');
  const capture = readIdentifier(captureId, 'capture identity');
  if (
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < RECOGNITION_LIMITS.minAttempt ||
    attempt > RECOGNITION_LIMITS.maxAttempt
  ) {
    throw new RecognitionError(
      'invalid-request',
      `The attempt identity must be an integer from ${RECOGNITION_LIMITS.minAttempt} to ${RECOGNITION_LIMITS.maxAttempt}.`,
    );
  }
  return { sessionId: session, captureId: capture, attempt };
}

/** Reads the enabled-engine selection of a prepare request, or throws `invalid-request`. */
export function readEngines(value: unknown): readonly RecognitionEngineName[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > RECOGNITION_LIMITS.maxEngines) {
    throw new RecognitionError(
      'invalid-request',
      `The enabled engines must list 1 to ${RECOGNITION_LIMITS.maxEngines} engine names.`,
    );
  }
  const engines = value.map((name) => readIdentifier(name, 'engine name'));
  if (new Set(engines).size !== engines.length) {
    throw new RecognitionError('invalid-request', 'The enabled engines must be unique.');
  }
  return engines;
}

/** Validates the bounded frame facts before any inference happens. */
export function readFrameFacts(facts: RecognitionFrameFacts | null): RecognitionFrameFacts {
  if (!facts || typeof facts !== 'object') {
    throw new RecognitionError('invalid-request', 'The captured frame could not be read.');
  }
  const { width, height, format, encodedBytes } = facts;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RecognitionError('invalid-request', 'The captured frame has invalid dimensions.');
  }
  if (Math.min(width, height) < RECOGNITION_LIMITS.minImageDimension) {
    throw new RecognitionError('invalid-request', 'The captured frame is too small.');
  }
  if (width * height > RECOGNITION_LIMITS.maxImagePixels) {
    throw new RecognitionError('invalid-request', 'The captured frame is too large.');
  }
  if (!recognitionImageFormats.includes(format)) {
    throw new RecognitionError('invalid-request', 'The captured frame format is not supported.');
  }
  if (
    encodedBytes !== null &&
    (!Number.isSafeInteger(encodedBytes) ||
      encodedBytes < 1 ||
      encodedBytes > RECOGNITION_LIMITS.maxImageBytes)
  ) {
    throw new RecognitionError('invalid-request', 'The encoded frame is too large.');
  }
  return { width, height, format, encodedBytes };
}

/** Keeps the bounded string report a pipeline supplied, dropping malformed entries. */
export function readVersions(value: unknown): Readonly<Record<string, string>> {
  return readDiagnostics(value, (entry) =>
    typeof entry === 'string' &&
    entry.length > 0 &&
    entry.length <= RECOGNITION_LIMITS.maxIdentifierLength
      ? entry
      : null,
  );
}

/** Keeps the bounded timing report a pipeline supplied, dropping malformed entries. */
export function readTimings(value: unknown): Readonly<Record<string, number>> {
  return readDiagnostics(value, (entry) =>
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : null,
  );
}

function readDiagnostics<T>(value: unknown, read: (entry: unknown) => T | null): Record<string, T> {
  const report: Record<string, T> = {};
  if (!value || typeof value !== 'object') {
    return report;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(report).length >= RECOGNITION_LIMITS.maxDiagnosticEntries) {
      break;
    }
    const kept = read(entry);
    if (kept !== null) {
      report[key] = kept;
    }
  }
  return report;
}
