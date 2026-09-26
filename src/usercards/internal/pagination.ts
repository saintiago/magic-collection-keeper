import { z } from 'zod';

import { UserCardsError } from './errors.js';
import { USERCARDS_LIMITS } from './model.js';

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

/**
 * Continuation of a bounded, offset-paged private list. It carries the revision the page was read
 * at, so a change after the page was read invalidates the continuation instead of skipping or
 * repeating records (docs/user-cards.md#interface).
 */
const continuationPayloadSchema = z.object({
  version: z.literal(1),
  offset: z.number().int().min(0),
  revision: z.string().min(1).max(identifierLength),
});

export type ContinuationPayload = z.infer<typeof continuationPayloadSchema>;

/**
 * Longest token `encodeContinuation` can emit: the revision is bounded by the identifier bound,
 * JSON escaping can spend six bytes on one string unit (`"\uXXXX"`), base64url expands by 4/3 and
 * the payload keys and an integer offset fit the remaining margin. The decoder accepts every token
 * its encoder can produce.
 */
export const maxContinuationLength = 4 * Math.ceil((6 * identifierLength + 64) / 3);

export function encodeContinuation(payload: ContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeContinuation(token: string, message: string): ContinuationPayload {
  const unreadable = new UserCardsError('invalid-request', message);
  if (typeof token !== 'string' || token.length === 0 || token.length > maxContinuationLength) {
    throw unreadable;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadable;
  }
  const parsed = continuationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadable;
  }
  return parsed.data;
}
