import { z } from 'zod';
import { finishes } from '../../catalog/contract.js';
import { USERCARDS_LIMITS, copyConditions, type ImportCandidate } from './model.js';

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

export const referenceSchema = z.string().min(1).max(identifierLength);

export const revisionSchema = z.number().int().min(1);

/**
 * One pending or reviewed quantity. Its meaning follows the destination its confirmation applies,
 * so it is an intended quantity bounded by the association product bound rather than by the
 * request batch size the writes are carried in (docs/user-cards.md#records-and-associations).
 */
export const quantitySchema = z.number().int().min(1).max(USERCARDS_LIMITS.maxAssociationQuantity);

export const conditionSchema = z.enum(copyConditions).nullable();

export const finishSchema = z.enum(finishes);

const candidateSchema = z.object({
  printingId: referenceSchema,
  provider: referenceSchema,
  evidence: referenceSchema,
});

export const candidatesSchema = z.array(candidateSchema).max(USERCARDS_LIMITS.maxImportCandidates);

export function distinctCandidates(candidates: readonly ImportCandidate[]): ImportCandidate[] {
  const seen = new Set<string>();
  const distinct: ImportCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.printingId}\u0000${candidate.provider}\u0000${candidate.evidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(candidate);
    }
  }
  return distinct;
}
