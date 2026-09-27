/**
 * Recent card activity of the UserInterface
 * (docs/user-interface.md#browsing-and-organization, docs/architecture.md#cardlist).
 *
 * Home presents the cards the account opened, most recent first. The activity is presentation
 * state the UserInterface owns, not provider data: browsing records the entry it opens, Home reads
 * the recorded entries back as a list source, and no provider query is needed for it. The store is
 * keyed by the verified account and keeps only the account the pages present, so a changed account
 * removes the previous account's activity instead of presenting it again later; both the entries of
 * one account and the accounts it keeps are bounded, so a long browsing session and repeated
 * account changes cannot grow presentation state without limit. An entry without resolved basic
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
  /** Keeps only the presented account's activity; a changed account removes the previous one's. */
  retain(accountId: string): void;
  /** Forgets one account's activity. */
  clear(accountId: string): void;
}

/**
 * One bounded store of recent card activity. `limit` entries stay per account and the
 * `accountLimit` most recently active accounts stay; recording for an unknown account or beyond
 * either bound drops the oldest activity instead of growing the store.
 */
export function createRecentCards(
  limit: number = UI_LIMITS.recentCards,
  accountLimit: number = UI_LIMITS.recentAccounts,
): UiRecentCards {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Recent card activity requires a positive, finite entry limit.');
  }
  if (!Number.isSafeInteger(accountLimit) || accountLimit < 1) {
    throw new TypeError('Recent card activity requires a positive, finite account limit.');
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
      const next = [recent, ...kept.filter((candidate) => candidate.key !== recent.key)].slice(
        0,
        limit,
      );
      // Re-inserting the account keeps the account that just recorded activity, so the bound
      // evicts the least recently active account instead of the busiest one.
      accounts.delete(account);
      accounts.set(account, next);
      while (accounts.size > accountLimit) {
        const oldest = accounts.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        accounts.delete(oldest);
      }
    },
    entries(accountId) {
      return [...(accounts.get(readAccountId(accountId)) ?? [])];
    },
    retain(accountId) {
      const account = readAccountId(accountId);
      for (const kept of [...accounts.keys()]) {
        if (kept !== account) {
          accounts.delete(kept);
        }
      }
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
  if (typeof entry.key !== 'string' || entry.key.length === 0 || entry.basic == null) {
    return null;
  }
  return entry;
}
