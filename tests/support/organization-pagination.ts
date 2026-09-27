/** Actual provider failures for the browser consumers' continuation recovery checks. */
import { createCatalog } from '../../src/catalog/index.js';
import { createUserCards } from '../../src/usercards/index.js';
import { publishCatalog } from './catalog-database.js';
import { createUserCardsTestDatabase } from './usercards-database.js';

let failures: ReturnType<typeof readFailures> | undefined;

export function organizationContinuationFailures(): ReturnType<typeof readFailures> {
  return (failures ??= readFailures());
}

async function readFailures() {
  const database = await createUserCardsTestDatabase();
  try {
    const fixture = {
      cards: [{ cardId: 'card', name: 'Card' }],
      printings: ['one', 'two'].map((printingId) => ({
        printingId,
        cardId: 'card',
        edition: 'SET',
        collectorNumber: printingId,
        language: 'en',
        finishes: ['nonfoil'],
        physical: true,
      })),
    };
    await publishCatalog(database, { ...fixture, revisionId: 'one' });
    const catalog = createCatalog({ sql: database.sql });
    const userCards = createUserCards({ sql: database.sql, catalog });
    const account = { accountId: 'pagination-browser-fixture' };
    const { tag } = await userCards.createTag(account, { kind: 'deck', label: 'Deck' });
    await userCards.createTag(account, { kind: 'location', label: 'Box' });
    for (const targetId of ['one', 'two']) {
      await userCards.createAssociation(account, {
        tagId: tag.tagId,
        targetLevel: 'printing',
        targetId,
        quantity: 2,
      });
    }
    const tags = await userCards.listTags(account, { pageSize: 1 });
    const associations = await userCards.listAssociations(account, {
      tagId: tag.tagId,
      pageSize: 1,
    });
    const printings = await catalog.listCardPrintings('card', { pageSize: 1 });
    if (!tags.continuation || !associations.continuation || !printings.continuation) {
      throw new Error('Provider fixture did not produce all continuations.');
    }
    await userCards.renameTag(account, { tagId: tag.tagId, expectedRevision: 1, label: 'Renamed' });
    await publishCatalog(database, { ...fixture, revisionId: 'two' });
    return {
      tags: await failure(
        userCards.listTags(account, { pageSize: 1, continuation: tags.continuation }),
      ),
      associations: await failure(
        userCards.listAssociations(account, {
          tagId: tag.tagId,
          pageSize: 1,
          continuation: associations.continuation,
        }),
      ),
      printings: await failure(
        catalog.listCardPrintings('card', {
          pageSize: 1,
          continuation: printings.continuation,
        }),
      ),
    };
  } finally {
    await database.close();
  }
}

async function failure(
  result: Promise<unknown>,
): Promise<{ code: 'conflict' | 'stale-continuation'; message: string }> {
  try {
    await result;
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      (cause.code === 'conflict' || cause.code === 'stale-continuation')
    ) {
      return { code: cause.code, message: cause.message };
    }
    throw cause;
  }
  throw new Error('The provider accepted an expired continuation.');
}
