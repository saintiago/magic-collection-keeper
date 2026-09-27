import type {
  CardId,
  CatalogReference,
  CatalogResolution,
  PrintingId,
} from '../../catalog/index.js';

import { RecognitionError } from './errors.js';
import {
  RECOGNITION_LIMITS,
  readTimings,
  readVersions,
  recognitionCardPresenceStates,
  recognitionStatuses,
  type RecognitionCandidate,
  type RecognitionCatalogPort,
  type RecognitionDisagreement,
  type RecognitionEngineCandidate,
  type RecognitionEngineOutcome,
  type RecognitionEvidence,
  type RecognitionIdentity,
  type RecognitionReading,
  type RecognitionSuggestion,
} from './model.js';

export interface RecognitionMappingRequest {
  readonly identity: RecognitionIdentity;
  readonly revision: number;
  readonly catalog: RecognitionCatalogPort;
  /** Aborted attempts never resolve candidates or deliver a reading. */
  readonly signal: AbortSignal;
}

/**
 * Maps one raw pipeline outcome into the provider-owned reading (docs/recognition.md#interface).
 *
 * The raw outcome stays behind this boundary: candidate identities are validated and enriched
 * against the published Catalog, printing evidence is retained as the pipeline reported it, and a
 * representative suggestion never becomes evidence of the observed edition. No-card, multiple-card
 * and ambiguous geometry, a possible outcome without a usable candidate and a candidate missing
 * from the published Catalog all yield the same honest `unknown` reading instead of a successful
 * identity (docs/recognition.md#execution).
 */
export async function mapEngineOutcome(
  outcome: unknown,
  request: RecognitionMappingRequest,
): Promise<RecognitionReading> {
  const value = outcome as Partial<RecognitionEngineOutcome> | null | undefined;
  if (!value || typeof value !== 'object') {
    throw new RecognitionError(
      'unavailable',
      'The recognition engine returned an unsupported outcome.',
    );
  }
  if (value.status !== recognitionStatuses[0] && value.status !== recognitionStatuses[1]) {
    throw new RecognitionError(
      'unavailable',
      `The recognition engine reported an unsupported status (${String(value.status)}).`,
    );
  }
  const status = value.status;
  const evidence = readEvidence(value.evidence);

  // No usable identity when the engine is uncertain, when geometry says the frame does not hold
  // exactly one card, or when no reported candidate survives catalog validation.
  const reported =
    status === 'possible' && geometryAdmitsIdentity(evidence)
      ? readCandidates(value.candidates)
      : [];
  const candidates = await resolveCandidates(reported, request);

  return {
    identity: request.identity,
    revision: request.revision,
    status: candidates.length > 0 ? 'possible' : 'unknown',
    candidates,
    suggestion: readSuggestion(candidates, evidence),
    evidence,
    provisional: value.provisional === true,
    disagreement: readDisagreement(candidates),
    versions: readVersions(value.versions),
    timings: readTimings(value.timings),
  };
}

function geometryAdmitsIdentity(evidence: RecognitionEvidence): boolean {
  return evidence.cardPresence === null || evidence.cardPresence === 'single';
}

function readEvidence(value: unknown): RecognitionEvidence {
  const evidence = value as Partial<RecognitionEvidence> | null | undefined;
  return {
    printingId: readOptionalIdentifier(evidence?.printingId),
    titleLanguage: readOptionalIdentifier(evidence?.titleLanguage),
    titleCorroborated: evidence?.titleCorroborated === true,
    cardPresence:
      recognitionCardPresenceStates.find((state) => state === evidence?.cardPresence) ?? null,
  };
}

function readOptionalIdentifier(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= RECOGNITION_LIMITS.maxIdentifierLength
    ? value
    : null;
}

function readCandidates(value: unknown): readonly RecognitionEngineCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: RecognitionEngineCandidate[] = [];
  for (const entry of value.slice(0, RECOGNITION_LIMITS.maxEngineCandidates)) {
    const candidate = entry as Partial<RecognitionEngineCandidate> | null | undefined;
    const cardId = readOptionalIdentifier(candidate?.cardId);
    const printingId = readOptionalIdentifier(candidate?.printingId);
    if (cardId === null || printingId === null) {
      continue;
    }
    candidates.push({
      cardId,
      printingId,
      name:
        typeof candidate?.name === 'string'
          ? candidate.name.slice(0, RECOGNITION_LIMITS.maxCandidateNameLength)
          : '',
      score:
        typeof candidate?.score === 'number' && Number.isFinite(candidate.score)
          ? candidate.score
          : null,
    });
  }
  return candidates;
}

/**
 * Validates candidate identities against the published Catalog and resolves canonical names.
 * A candidate whose printing is missing or does not belong to the proposed playable identity is
 * dropped; the reading keeps the remaining engine order.
 */
async function resolveCandidates(
  reported: readonly RecognitionEngineCandidate[],
  request: RecognitionMappingRequest,
): Promise<readonly RecognitionCandidate[]> {
  if (reported.length === 0) {
    return [];
  }
  const references: CatalogReference[] = [];
  for (const candidate of reported) {
    references.push({ kind: 'printing', printingId: candidate.printingId });
    references.push({ kind: 'card', cardId: candidate.cardId });
  }
  let resolution: CatalogResolution;
  try {
    resolution = await request.catalog.resolve(references);
  } catch (error) {
    throw new RecognitionError('unavailable', 'Candidate identities could not be validated.', {
      cause: error,
    });
  }
  request.signal.throwIfAborted();
  const resolved: RecognitionCandidate[] = [];
  const seen = new Set<PrintingId>();
  for (const candidate of reported) {
    if (resolved.length >= RECOGNITION_LIMITS.maxCandidates) {
      break;
    }
    const printing = resolution.printings.get(candidate.printingId);
    const card = resolution.cards.get(candidate.cardId);
    if (
      !printing ||
      !card ||
      printing.cardId !== candidate.cardId ||
      seen.has(printing.printingId)
    ) {
      continue;
    }
    seen.add(printing.printingId);
    resolved.push({
      cardId: card.cardId,
      printingId: printing.printingId,
      name: card.name,
      score: candidate.score,
    });
  }
  return resolved;
}

/**
 * The suggestion is the candidate whose printing the pipeline corroborated, or the leading
 * candidate as an editable representative. It always belongs to the candidate set, and only
 * engine evidence can make it corroborated (docs/recognition.md#interface).
 */
function readSuggestion(
  candidates: readonly RecognitionCandidate[],
  evidence: RecognitionEvidence,
): RecognitionSuggestion | null {
  const leading = candidates[0];
  if (!leading) {
    return null;
  }
  const corroborated =
    evidence.printingId === null
      ? -1
      : candidates.findIndex((candidate) => candidate.printingId === evidence.printingId);
  const candidateIndex = corroborated >= 0 ? corroborated : 0;
  const candidate = candidates[candidateIndex] ?? leading;
  return {
    candidateIndex,
    printingId: candidate.printingId,
    basis: corroborated >= 0 ? 'corroborated' : 'representative',
  };
}

function readDisagreement(
  candidates: readonly RecognitionCandidate[],
): RecognitionDisagreement | null {
  const cardIds: CardId[] = [];
  for (const candidate of candidates) {
    if (!cardIds.includes(candidate.cardId)) {
      cardIds.push(candidate.cardId);
    }
  }
  return cardIds.length > 1 ? { cardIds } : null;
}
