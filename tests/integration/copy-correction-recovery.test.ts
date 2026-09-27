/** Lost correction responses across the UI and real UserCards/Catalog storage boundary. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/catalog/index.js';
import { correctCopy, createCopyAccess } from '../../src/ui/index.js';
import { createUserCards, type UserCards } from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import {
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../support/usercards-database.js';

const account = { accountId: 'copy-recovery-account' };

describe('copy correction recovery', () => {
  let database: UserCardsTestDatabase;
  let userCards: UserCards;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [{ cardId: 'card-1', name: 'Lightning Bolt' }],
      printings: [
        {
          printingId: 'printing-1',
          cardId: 'card-1',
          edition: 'M11',
          collectorNumber: '149',
          language: 'en',
          finishes: ['nonfoil', 'foil'],
          physical: true,
        },
      ],
    });
    userCards = createUserCards({
      sql: database.sql,
      catalog: createCatalog({ sql: database.sql }),
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it.each(['location', 'correction'] as const)(
    'keeps a lost conflict unknown after another %s advances matching attributes',
    async (competingOperation) => {
      const created = await userCards.createCopies(account, {
        printingId: 'printing-1',
        finish: 'foil',
        condition: 'LP',
        quantity: 1,
      });
      const original = created.copies[0]!;
      const input = { ...original, expectedRevision: original.revision };
      if (competingOperation === 'location') {
        const location = await userCards.createTag(account, { kind: 'location', label: 'Binder' });
        await userCards.setCopyLocation(account, {
          copyId: original.copyId,
          expectedRevision: original.revision,
          locationTagId: location.tag.tagId,
        });
      } else {
        await userCards.correctCopy(account, input);
      }
      const access = createCopyAccess({
        readCopies: (ids) => userCards.readCopies(account, ids),
        correctCopy: (correction) => userCards.correctCopy(account, correction),
      });

      let providerFailure: unknown;
      const outcome = await correctCopy(
        {
          read: access.read,
          async correct(correction) {
            // The real provider rejects this operation; only its response is lost.
            return access.correct(correction).catch((cause: unknown) => {
              providerFailure = cause;
              throw new Error('The response was lost.');
            });
          },
        },
        input,
      );

      expect(providerFailure).toMatchObject({ code: 'conflict' });
      expect(outcome.status).toBe('unknown');
      expect(outcome.copy).toEqual({ ...original, revision: original.revision + 1 });

      // Retrying the old revision remains guarded. A reviewed retry can confirm its own result.
      expect((await correctCopy(access, input)).status).toBe('conflict');
      const retry = await correctCopy(access, {
        ...input,
        expectedRevision: outcome.copy!.revision,
      });
      expect(retry.status).toBe('committed');
      expect(retry.copy?.revision).toBe(original.revision + 2);
    },
  );
});
