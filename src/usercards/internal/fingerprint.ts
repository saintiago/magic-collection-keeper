/**
 * Content digests of staged import input (docs/user-cards.md#import-and-capture-state). A staged
 * line, a capture observation and a parsed source line are each identified by the digest of what
 * the caller asked to stage, so identical input replays and different input under one identity is
 * refused. Staging and source-import parsing share one canonical encoding, so two paths that stage
 * the same line agree on its identity.
 */

import { createHash } from 'node:crypto';

import type { Finish } from '../../catalog/contract.js';
import type { CopyCondition, ImportCandidate } from './model.js';

/** Digest of a canonical value, so identical input replays and different input fails. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Candidates in a canonical order: their storage and identity do not depend on delivery order. */
export function candidateTuples(
  candidates: readonly ImportCandidate[],
): readonly (readonly string[])[] {
  return candidates
    .map((candidate) => [candidate.printingId, candidate.provider, candidate.evidence] as const)
    .sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
}

/** Reviewed target data and alternatives of one staged source line. */
export interface StagedLineContent {
  readonly cardId: string | null;
  readonly printingId: string | null;
  readonly finish: Finish | null;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
  readonly candidates: readonly ImportCandidate[];
}

/** Digest of one staged source line: restaging identical content returns its recorded state. */
export function stagedLineFingerprint(line: StagedLineContent): string {
  return fingerprint({
    cardId: line.cardId,
    printingId: line.printingId,
    finish: line.finish,
    condition: line.condition,
    quantity: line.quantity,
    candidates: candidateTuples(line.candidates),
  });
}
