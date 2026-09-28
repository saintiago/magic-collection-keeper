/**
 * Account-local recent card activity (docs/card-list.md#interface,
 * docs/card-list.md#internal-design).
 *
 * The activity is local browsing history, not provider data: a consumer records the typed entry
 * the account explicitly opened, reads the recorded entries back as a list source, and no server
 * or cross-device history is implied. The store is keyed by the verified account and keeps a
 * bounded number of entries per account, so a long browsing session cannot grow presentation
 * state without limit; a consumer that leaves an account clears that account's activity, and a
 * later sign-in of the same account never reads it again. An entry without resolved basic
 * information carries no card activity to present and is not recorded. Loading, scrolling or
 * revisiting a row adds no entry.
 */

import { CARD_LIST_LIMITS } from './limits.js';
import type { CardListEntry, CardListSource } from './contract.js';

/** Recent card activity of the accounts one consumer presented, most recent first per account. */
export interface CardListRecentActivity {
  /** Records one entry the account opened; an entry already kept moves to the front. */
  record(accountId: string, entry: CardListEntry): void;
  /** Entries one account's recent list presents, most recent first. */
  entries(accountId: string): readonly CardListEntry[];
  /** Forgets one account's activity; the account left the consumer or its session ended. */
  clear(accountId: string): void;
  /** Constructs the recent-list source of one account. */
  source(accountId: string): CardListSource<string>;
}

/**
 * One bounded store of recent card activity. `limit` entries stay per account; recording for an
 * unknown account or beyond the bound drops the oldest activity instead of growing the store.
 */
export function createRecentActivity(
  limit: number = CARD_LIST_LIMITS.recentCards,
): CardListRecentActivity {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Recent card activity requires a positive, finite entry limit.');
  }
  const accounts = new Map<string, readonly CardListEntry[]>();

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
    source(accountId) {
      const account = readAccountId(accountId);
      return {
        // The recorded activity is this source's authoritative read; a committed publication
        // position never changes the local history, so no change reacquires it.
        affects: () => false,
        load() {
          return Promise.resolve({
            status: 'page',
            entries: accounts.get(account) ?? [],
            continuation: null,
            current: true,
          });
        },
      };
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
function readRecentEntry(value: unknown): CardListEntry | null {
  const entry = value as CardListEntry | null | undefined;
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  if (
    typeof entry.key !== 'string' ||
    entry.key.length === 0 ||
    entry.key.length > CARD_LIST_LIMITS.entryKey ||
    entry.basic == null
  ) {
    return null;
  }
  return entry;
}
