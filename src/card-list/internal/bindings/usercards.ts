/**
 * UserCards bindings of CardList (docs/card-list.md#required-interfaces-and-source-bindings,
 * docs/user-cards.md#browser-operation-lifecycle).
 *
 * UserCards owns the account's private data changes: after a committed operation its browser
 * facade publishes a local invalidation naming the scope, the records and the pending imports the
 * change may have affected. A list
 * subscribes to the account-scoped notifications and reacquires the content it presents through
 * its own source; a consumer never patches rows for a change.
 */

import type { UserCardsChange } from '../../../usercards/browser.js';

import type { CardListChangeSource } from '../contract.js';

/** One account's UserCards facade as a CardList change source. */
export interface CardListUserCardsChanges {
  subscribe(listener: (change: UserCardsChange) => void): () => void;
}

/**
 * Builds the change source over one account's UserCards browser operations. The facade is already
 * scoped to its account, so a list never observes another account's records or positions.
 */
export function usercardsChanges(userCards: CardListUserCardsChanges): CardListChangeSource {
  if (typeof userCards?.subscribe !== 'function') {
    throw new TypeError('Committed changes are observed through the UserCards facade.');
  }
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('A CardList change subscriber is a function.');
      }
      return userCards.subscribe((change) => {
        listener({
          scope: change.scope,
          records: change.records.map((record) => recordIdentity(record)),
          imports: change.imports.map((importId) => String(importId)),
        });
      });
    },
  };
}

/** Identity one affected record reference carries. */
function recordIdentity(record: UserCardsChange['records'][number]): string {
  switch (record.kind) {
    case 'copy':
      return record.copyId;
    case 'tag':
      return record.tagId;
    case 'association':
      return record.associationId;
  }
}
