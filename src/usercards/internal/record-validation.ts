import { z } from 'zod';
import { USERCARDS_LIMITS } from './model.js';

export const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

export const referenceSchema = z.string().min(1).max(identifierLength);

export const referencesSchema = z.array(referenceSchema).max(USERCARDS_LIMITS.maxReadReferences);

export const revisionSchema = z.number().int().min(1);

/** Reads each requested reference once, in request order. */
export function distinctReferences(references: readonly string[]): string[] {
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (!seen.has(reference)) {
      seen.add(reference);
      requested.push(reference);
    }
  }
  return requested;
}
