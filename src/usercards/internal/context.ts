import { z } from 'zod';

import { UserCardsError } from './errors.js';
import { USERCARDS_LIMITS, type TrustedUserContext } from './model.js';

const userContextSchema = z.object({
  accountId: z.string().min(1).max(USERCARDS_LIMITS.maxIdentifierLength),
});

/** Missing, invalid or empty trusted context never reaches a private record. */
export function accountIdFrom(context: TrustedUserContext | undefined): string {
  const parsed = userContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new UserCardsError(
      'invalid-request',
      'Trusted user context with an account identity is required.',
    );
  }
  return parsed.data.accountId;
}
