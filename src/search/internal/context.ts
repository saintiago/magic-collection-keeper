import type { TrustedUserContext } from '../../usercards/index.js';

import { SEARCH_LIMITS } from './model.js';

/**
 * Verified account identity carried by trusted context, or null when the context is absent or
 * unusable. Search never derives the account from a query field (docs/search.md#request-and-result).
 */
export function readTrustedAccountId(
  context: TrustedUserContext | null | undefined,
): string | null {
  const accountId = context?.accountId;
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > SEARCH_LIMITS.maxIdentifierLength
  ) {
    return null;
  }
  return accountId;
}
