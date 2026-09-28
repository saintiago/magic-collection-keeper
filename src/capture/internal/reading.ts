/**
 * Recognition readings as Capture consumes and publishes them (docs/recognition.md#interface,
 * docs/capture.md#admission-and-lifecycle).
 *
 * One reading carries the frame-correlated geometry evidence and the candidate identities of the
 * same capture. Capture maps it into its own reading summary, and admits it only when the geometry
 * establishes exactly one card and the reading names a usable identity: geometry decides admission
 * independently of identity, and a frame whose geometry is not established is never affirmative
 * evidence. The observation UserCards stages is the suggested printing with the ordered
 * alternatives beside it; a suggestion is the editable starting point of review and never evidence
 * of the observed edition.
 */

import type { RecognitionReading } from '../../recognition/index.js';
import type { ImportCandidate, StageCaptureInput } from '../../usercards/index.js';

import type { CaptureCandidate, CaptureReading } from './contract.js';

/** Evidence labels one stored alternative carries; the review presents them beside the printing. */
const captureEvidenceLabels = {
  /** Whole-title corroboration supported this printing. */
  title: 'title-evidence',
  /** The engine ranked this printing without corroborating the observed edition. */
  ranking: 'engine-ranking',
} as const;

/** One reading as the session publishes it: geometry, candidates, suggestion and uncertainty. */
export function captureReading(reading: RecognitionReading): CaptureReading {
  const suggested =
    reading.suggestion === null
      ? null
      : (reading.candidates[reading.suggestion.candidateIndex]?.printingId ?? null);
  return {
    captureId: reading.identity.captureId,
    attempt: reading.identity.attempt,
    revision: reading.revision,
    status: reading.status,
    candidates: captureCandidates(reading),
    suggestedPrintingId: suggested,
    presence: reading.evidence.cardPresence,
    provisional: reading.provisional,
    uncertain: reading.disagreement !== null,
  };
}

/** The ordered candidates of one reading with the evidence each printing carries. */
export function captureCandidates(reading: RecognitionReading): readonly CaptureCandidate[] {
  return reading.candidates.map((candidate) => ({
    cardId: candidate.cardId,
    printingId: candidate.printingId,
    name: candidate.name,
    evidence: carriesTitleEvidence(reading, candidate.printingId)
      ? captureEvidenceLabels.title
      : captureEvidenceLabels.ranking,
  }));
}

/**
 * One capture observation as UserCards stages it: the printing the reading suggests, with the
 * reading's ordered alternatives beside it, or null when the reading names no usable identity.
 * The suggestion is the editable starting point of review and never evidence of the observed
 * edition (docs/recognition.md#interface).
 */
export function captureObservation(
  sessionId: string,
  captureId: string,
  reading: RecognitionReading,
): StageCaptureInput | null {
  if (reading.status !== 'possible' || reading.candidates.length === 0) {
    return null;
  }
  const suggested =
    reading.suggestion === null
      ? reading.candidates[0]
      : reading.candidates[reading.suggestion.candidateIndex];
  const printingId = suggested?.printingId ?? reading.candidates[0]?.printingId ?? null;
  if (printingId === null) {
    return null;
  }
  return {
    sessionId,
    captureId,
    printingId,
    // The provider takes the printing's first offered finish; review changes it explicitly.
    finish: null,
    candidates: [...storedCandidates(reading)],
  };
}

/** The recognition alternatives of one reading as the review stores them. */
export function storedCandidates(reading: RecognitionReading): readonly ImportCandidate[] {
  return reading.candidates.map((candidate) => ({
    printingId: candidate.printingId,
    // The public reading reports engine versions for the attempt, not for each candidate, so the
    // alternative names the component that produced it and the evidence it carried.
    provider: 'recognition',
    evidence: carriesTitleEvidence(reading, candidate.printingId)
      ? captureEvidenceLabels.title
      : captureEvidenceLabels.ranking,
  }));
}

/**
 * Whether the reading's own evidence supports this printing: the engine corroborated it, or the
 * suggestion is corroborated and names this candidate. The suggestion's own ranking is not
 * evidence and does not turn a representative printing into an observed edition.
 */
function carriesTitleEvidence(reading: RecognitionReading, printingId: string): boolean {
  return (
    reading.evidence.printingId === printingId ||
    (reading.suggestion?.basis === 'corroborated' && reading.suggestion.printingId === printingId)
  );
}
