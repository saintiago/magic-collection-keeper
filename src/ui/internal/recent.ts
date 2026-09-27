/**
 * Recent card activity of the UserInterface
 * (docs/user-interface.md#browsing-and-organization,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * Home presents the cards the account opened, most recent first. The activity is presentation
 * state the UserInterface owns, not provider data: browsing records the entry it opens, Home reads
 * the recorded entries back as a list source, and no provider query is needed for it. The store is
 * keyed by the verified account and keeps a bounded number of entries per account, so a long
 * browsing session cannot grow presentation state without limit; the shell reports every account it
 * leaves to the page implementations, which forget that account's activity, so a changed account
 * or a later sign-in of the same account never reads it again. An entry without resolved basic
 * information carries no card activity to present and is not recorded.
 */

import { UI_LIMITS } from './limits.js';
import type { UiListEntry } from './list.js';

/** Recent card activity of the accounts the UI presented, most recent first per account. */
export interface UiRecentCards {
  /** Records one entry the account opened; an entry already kept moves to the front. */
  record(accountId: string, entry: UiListEntry): void;
  /** Entries one account's Home presents, most recent first. */
  entries(accountId: string): readonly UiListEntry[];
  /** Forgets one account's activity; the account left the UI or its session ended. */
  clear(accountId: string): void;
}

/**
 * One bounded store of recent card activity. `limit` entries stay per account; recording for an
 * unknown account or beyond the bound drops the oldest activity instead of growing the store.
 */
export function createRecentCards(limit: number = UI_LIMITS.recentCards): UiRecentCards {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Recent card activity requires a positive, finite entry limit.');
  }
  const accounts = new Map<string, readonly UiListEntry[]>();

  return {
    record(accountId, entry) {
      const account = readAccountId(accountId);
      const recent = readRecentEntry(entry);
      if (recent === null) {
        return;
      }
      const kept = accounts.get(account) ?? [];
      accounts.set(
        account,
        [recent, ...kept.filter((candidate) => candidate.key !== recent.key)].slice(0, limit),
      );
    },
    entries(accountId) {
      return [...(accounts.get(readAccountId(accountId)) ?? [])];
    },
    clear(accountId) {
      accounts.delete(readAccountId(accountId));
    },
  };
}

function readAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('Recent card activity belongs to one verified account.');
  }
  return value;
}

/** One entry worth presenting again, or null when it carries no resolved card to open. */
function readRecentEntry(value: unknown): UiListEntry | null {
  const entry = value as UiListEntry | null | undefined;
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  if (
    typeof entry.key !== 'string' ||
    entry.key.length === 0 ||
    entry.key.length > UI_LIMITS.entryKey ||
    entry.basic == null
  ) {
    return null;
  }
  return entry;
}
