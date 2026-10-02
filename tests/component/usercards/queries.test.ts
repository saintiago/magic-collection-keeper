import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  createUserCardsQueries,
  createUserCardsReferencePreparation,
  type PhysicalCopy,
  type TrustedUserContext,
  type UserCards,
  type UserCardsQueryInput,
  USERCARDS_ACCOUNT_SCOPE_SQL,
  usercardsQueryGrants,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const bolt = {
  cardId: 'card-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};
const opt = {
  cardId: 'card-opt',
  name: 'Opt',
  colors: ['U'],
  colorIdentity: ['U'],
  manaValue: 1,
};
const planned = {
  cardId: 'card-planned',
  name: 'Planned Card',
  colors: [],
  colorIdentity: [],
  manaValue: 0,
};
const boltM11 = {
  printingId: 'printing-bolt-m11',
  cardId: bolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};
const optDom = {
  printingId: 'printing-opt-dom',
  cardId: opt.cardId,
  edition: 'DOM',
  collectorNumber: '60',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
};

describe('usercards current private queries', () => {
  let database: UserCardsTestDatabase;
  let userCards: UserCards;
  let boltFoil: PhysicalCopy;
  let boltNonfoil: PhysicalCopy;
  let deckId: string;
  let binderId: string;
  let boxId: string;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [bolt, opt, planned],
      printings: [boltM11, optDom],
    });
    userCards = createUserCards({
      sql: database.sql,
      catalog: createCatalog({ sql: database.sql }),
    });
    [boltFoil] = (
      await userCards.createCopies(alice, {
        printingId: boltM11.printingId,
        finish: 'foil',
        condition: 'LP',
        quantity: 1,
      })
    ).copies as [PhysicalCopy];
    [boltNonfoil] = (
      await userCards.createCopies(alice, {
        printingId: boltM11.printingId,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1,
      })
    ).copies as [PhysicalCopy];
    await userCards.createCopies(alice, {
      printingId: optDom.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    deckId = (await userCards.createTag(alice, { kind: 'deck', label: 'Spells' })).tag.tagId;
    binderId = (await userCards.createTag(alice, { kind: 'location', label: 'Binder' })).tag.tagId;
    boxId = (await userCards.createTag(alice, { kind: 'location', label: 'Box' })).tag.tagId;
    await userCards.setCopyLocation(alice, {
      copyId: boltFoil.copyId,
      expectedRevision: 1,
      locationTagId: binderId,
    });
    await userCards.setCopyLocation(alice, {
      copyId: boltNonfoil.copyId,
      expectedRevision: 1,
      locationTagId: boxId,
    });
    await userCards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'card',
      targetId: bolt.cardId,
      quantity: 4,
    });
    await userCards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'printing',
      targetId: optDom.printingId,
      quantity: 2,
    });
    await userCards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'copy',
      targetId: boltFoil.copyId,
    });
    await userCards.createAssociation(alice, {
      tagId: deckId,
      targetLevel: 'card',
      targetId: planned.cardId,
      quantity: 3,
    });
  });

  afterEach(async () => database.close());

  it('groups collection and tag membership at each requested level with exact quantities', async () => {
    const collection = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
    });
    expect(collection.entries.map((entry) => entry.target)).toEqual([
      { kind: 'card', cardId: bolt.cardId },
      { kind: 'card', cardId: opt.cardId },
    ]);
    expect(collection.entries.map((entry) => entry.ownedCopyCount)).toEqual([2, 1]);

    const cards = await userCards.query(alice, {
      scope: { kind: 'tag', tagId: deckId },
      resultLevel: 'card',
    });
    expect(cards.entries).toMatchObject([
      {
        target: { kind: 'card', cardId: bolt.cardId },
        intendedQuantity: 4,
        ownedCopyCount: 2,
        directAssociationCount: 1,
        derivedAssociationCount: 1,
      },
      {
        target: { kind: 'card', cardId: opt.cardId },
        intendedQuantity: 2,
        ownedCopyCount: 1,
        directAssociationCount: 0,
        derivedAssociationCount: 1,
      },
      {
        target: { kind: 'card', cardId: planned.cardId },
        intendedQuantity: 3,
        ownedCopyCount: 0,
        directAssociationCount: 1,
        derivedAssociationCount: 0,
      },
    ]);

    const printings = await userCards.query(alice, {
      scope: { kind: 'tag', tagId: deckId },
      resultLevel: 'printing',
    });
    expect(printings.entries).toMatchObject([
      {
        target: { kind: 'printing', printingId: boltM11.printingId },
        intendedQuantity: null,
        directAssociationCount: 0,
        derivedAssociationCount: 1,
      },
      {
        target: { kind: 'printing', printingId: optDom.printingId },
        intendedQuantity: 2,
        directAssociationCount: 1,
        derivedAssociationCount: 0,
      },
    ]);

    const copies = await userCards.query(alice, {
      scope: { kind: 'tag', tagId: deckId },
      resultLevel: 'copy',
    });
    expect(copies.entries).toMatchObject([
      {
        target: { kind: 'copy', copyId: boltFoil.copyId },
        ownedCopyCount: 1,
        directAssociationCount: 1,
        derivedAssociationCount: 0,
      },
    ]);
  });

  it('applies physical predicates to the same copy and supports typed identity refinement', async () => {
    const impossible = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
      criteria: [
        { kind: 'finish', finish: 'foil' },
        { kind: 'condition', condition: 'NM' },
      ],
    });
    expect(impossible.entries).toEqual([]);

    const siblingOfSelectedCopy = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
      criteria: [
        { kind: 'identity', references: [{ kind: 'copy', copyId: boltFoil.copyId }] },
        { kind: 'condition', condition: 'NM' },
      ],
    });
    expect(siblingOfSelectedCopy.entries).toEqual([]);

    const siblingOutsideScope = await userCards.query(alice, {
      scope: { kind: 'tag', tagId: binderId },
      resultLevel: 'card',
      criteria: [{ kind: 'finish', finish: 'nonfoil' }],
    });
    expect(siblingOutsideScope.entries).toEqual([]);

    const siblingOutsideTag = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
      criteria: [
        { kind: 'tag', tagId: binderId },
        { kind: 'finish', finish: 'nonfoil' },
      ],
    });
    expect(siblingOutsideTag.entries).toEqual([]);

    const matching = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
      criteria: [
        { kind: 'finish', finish: 'foil' },
        { kind: 'condition', condition: 'LP' },
        { kind: 'location', tagId: binderId },
      ],
    });
    expect(matching.entries.map((entry) => entry.target)).toEqual([
      { kind: 'card', cardId: bolt.cardId },
    ]);

    const refined = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'copy',
      criteria: [{ kind: 'identity', references: [{ kind: 'card', cardId: bolt.cardId }] }],
    });
    expect(refined.entries.map((entry) => entry.target)).toEqual(
      [boltFoil.copyId, boltNonfoil.copyId].sort().map((copyId) => ({ kind: 'copy', copyId })),
    );
  });

  it.each(['card', 'printing', 'copy'] as const)(
    'correlates scope, tags and identities without physical filters at %s level',
    async (resultLevel) => {
      const outsideIdentity = {
        kind: 'identity',
        references: [{ kind: 'copy', copyId: boltNonfoil.copyId }],
      } as const;
      const requests: UserCardsQueryInput[] = [
        { scope: { kind: 'tag', tagId: binderId }, resultLevel, criteria: [outsideIdentity] },
        {
          scope: { kind: 'collection' },
          resultLevel,
          criteria: [{ kind: 'tag', tagId: binderId }, outsideIdentity],
        },
        {
          scope: { kind: 'tag', tagId: binderId },
          resultLevel,
          criteria: [{ kind: 'tag', tagId: boxId }],
        },
        {
          scope: { kind: 'collection' },
          resultLevel,
          criteria: [
            { kind: 'tag', tagId: binderId },
            { kind: 'tag', tagId: boxId },
          ],
        },
        {
          scope: { kind: 'collection' },
          resultLevel,
          criteria: [
            outsideIdentity,
            {
              kind: 'identity',
              references: [{ kind: 'copy', copyId: boltFoil.copyId }],
            },
          ],
        },
      ];
      for (const request of requests) {
        expect(await userCards.query(alice, { ...request, pageSize: 1 })).toMatchObject({
          entries: [],
          totalCount: 0,
          continuation: null,
        });
      }
      const matching = await userCards.query(alice, {
        scope: { kind: 'tag', tagId: binderId },
        resultLevel,
        criteria: [
          { kind: 'tag', tagId: deckId },
          { kind: 'identity', references: [{ kind: 'copy', copyId: boltFoil.copyId }] },
        ],
      });
      expect(matching.totalCount).toBe(1);
      expect(matching.entries).toHaveLength(1);
    },
  );

  it('retains printing correlation and copy-free intentions through tag and identity filters', async () => {
    const otherPrinting = { ...boltM11, printingId: 'printing-bolt-other' };
    await publishCatalog(database, {
      revisionId: 'revision-2',
      cards: [bolt, opt, planned],
      printings: [boltM11, otherPrinting, optDom],
    });
    const wishlist = (await userCards.createTag(alice, { kind: 'wishlist', label: 'Wish' })).tag;
    const otherWishlist = (await userCards.createTag(alice, { kind: 'wishlist', label: 'Other' }))
      .tag;
    await userCards.createAssociation(alice, {
      tagId: wishlist.tagId,
      targetLevel: 'printing',
      targetId: otherPrinting.printingId,
      quantity: 3,
    });
    await userCards.createAssociation(alice, {
      tagId: otherWishlist.tagId,
      targetLevel: 'printing',
      targetId: boltM11.printingId,
      quantity: 2,
    });
    for (const resultLevel of ['card', 'printing'] as const) {
      for (const criteria of [
        [{ kind: 'identity', references: [{ kind: 'printing', printingId: boltM11.printingId }] }],
        [{ kind: 'tag', tagId: otherWishlist.tagId }],
      ] satisfies UserCardsQueryInput['criteria'][]) {
        expect(
          await userCards.query(alice, {
            scope: { kind: 'tag', tagId: wishlist.tagId },
            resultLevel,
            criteria,
          }),
        ).toMatchObject({ entries: [], totalCount: 0, continuation: null });
      }
      const matching = await userCards.query(alice, {
        scope: { kind: 'tag', tagId: wishlist.tagId },
        resultLevel,
        criteria: [
          { kind: 'tag', tagId: wishlist.tagId },
          {
            kind: 'identity',
            references: [{ kind: 'printing', printingId: otherPrinting.printingId }],
          },
        ],
      });
      expect(matching.entries).toMatchObject([{ intendedQuantity: 3 }]);
      expect(matching.totalCount).toBe(1);
      // An unknown physical condition still needs a physical copy.
      expect(
        (
          await userCards.query(alice, {
            scope: { kind: 'tag', tagId: wishlist.tagId },
            resultLevel,
            criteria: [{ kind: 'condition', condition: null }],
          })
        ).totalCount,
      ).toBe(0);
    }
    const plannedResult = await userCards.query(alice, {
      scope: { kind: 'tag', tagId: deckId },
      resultLevel: 'card',
      criteria: [
        { kind: 'tag', tagId: deckId },
        { kind: 'owned', value: false },
        { kind: 'identity', references: [{ kind: 'card', cardId: planned.cardId }] },
      ],
    });
    expect(plannedResult.entries).toMatchObject([{ intendedQuantity: 3, ownedCopyCount: 0 }]);
  });

  it('binds continuation to account, request and the account revision only', async () => {
    const first = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'copy',
      pageSize: 1,
    });
    expect(first.continuation).not.toBeNull();

    await userCards.createCopies(bob, {
      printingId: boltM11.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });
    const second = await userCards.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'copy',
      pageSize: 1,
      continuation: first.continuation as string,
    });
    expect(second.entries).toHaveLength(1);

    await userCards.renameTag(alice, {
      tagId: deckId,
      expectedRevision: 1,
      label: 'Renamed',
    });
    const stale = await captureUserCardsError(
      userCards.query(alice, {
        scope: { kind: 'collection' },
        resultLevel: 'copy',
        pageSize: 1,
        continuation: second.continuation as string,
      }),
    );
    expect(stale.code).toBe('stale-continuation');

    const changedRequest = await captureUserCardsError(
      userCards.query(alice, {
        scope: { kind: 'collection' },
        resultLevel: 'printing',
        pageSize: 1,
        continuation: first.continuation as string,
      }),
    );
    expect(changedRequest.code).toBe('stale-continuation');
  });

  it('reads keyed zero/absence fragments and authorized physical detail', async () => {
    const result = await userCards.readFragments(alice, {
      tagId: deckId,
      references: [
        { kind: 'card', cardId: bolt.cardId },
        { kind: 'printing', printingId: boltM11.printingId },
        { kind: 'copy', copyId: boltFoil.copyId },
        { kind: 'copy', copyId: 'foreign-or-missing' },
      ],
    });
    expect(result.missing).toEqual([{ kind: 'copy', copyId: 'foreign-or-missing' }]);
    expect(result.fragments.get(`card:${bolt.cardId}`)).toMatchObject({
      ownedCopyCount: 2,
      physicalLocationCount: 2,
      intendedQuantity: 4,
    });
    expect(result.fragments.get(`printing:${boltM11.printingId}`)).toMatchObject({
      ownedCopyCount: 2,
      intendedQuantity: 0,
    });
    expect(result.fragments.get(`copy:${boltFoil.copyId}`)?.tagIds).toEqual(
      expect.arrayContaining([deckId, binderId]),
    );

    const detail = await userCards.readPhysicalDetail(alice, boltFoil.copyId);
    expect(detail.copy.copyId).toBe(boltFoil.copyId);
    expect(detail.memberships.map((membership) => membership.tagId)).toEqual(
      expect.arrayContaining([deckId, binderId]),
    );
    const hidden = await captureUserCardsError(userCards.readPhysicalDetail(bob, boltFoil.copyId));
    expect(hidden.code).toBe('not-found');
    const hiddenTagQuery = await captureUserCardsError(
      userCards.query(bob, { scope: { kind: 'tag', tagId: deckId }, resultLevel: 'card' }),
    );
    expect(hiddenTagQuery.code).toBe('not-found');
    const hiddenTagFragments = await captureUserCardsError(
      userCards.readFragments(bob, {
        tagId: deckId,
        references: [{ kind: 'card', cardId: bolt.cardId }],
      }),
    );
    expect(hiddenTagFragments.code).toBe('not-found');
  });

  it('runs with the provider query role while storage rejects writes and unrelated private state', async () => {
    const [bobCopy] = (
      await userCards.createCopies(bob, {
        printingId: boltM11.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      })
    ).copies as [PhysicalCopy];
    await database.exec('create role keeper_usercards_query');
    await database.exec(usercardsQueryGrants('keeper_usercards_query'));
    expect(() => usercardsQueryGrants('query"; drop schema usercards_private; --')).toThrow(
      TypeError,
    );

    await database.exec('set role keeper_usercards_query');
    try {
      await expect(database.query('select copy_id from usercards_private.copy')).rejects.toThrow(
        /permission denied/,
      );
      for (const relation of [
        'account_state',
        'printing_reference',
        'copy',
        'tag',
        'association',
      ]) {
        await expect(
          database.query(`select * from usercards_current_query.${relation}`),
        ).resolves.toEqual([]);
      }
      const scopedCopies = await database.sql.transaction(async (statements) => {
        await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
        return statements.query(
          'select copy_id from usercards_current_query.copy order by copy_id',
        );
      });
      expect(scopedCopies).toHaveLength(3);
      expect(scopedCopies).not.toContainEqual({ copy_id: bobCopy.copyId });
      await expect(
        database.sql.transaction(async (statements) => {
          await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
          await statements.query("select set_config('usercards.account_id', '', true)");
          return statements.query('select copy_id from usercards_current_query.copy');
        }),
      ).resolves.toEqual([]);
      const readOnly = createUserCardsQueries({ sql: database.sql });
      await expect(
        readOnly.query(alice, { scope: { kind: 'collection' }, resultLevel: 'copy' }),
      ).resolves.toMatchObject({ totalCount: 3 });
      await expect(
        database.query('select copy_id from usercards_current_query.copy'),
      ).resolves.toEqual([]);
      await expect(
        database.exec(
          "insert into usercards_private.printing_reference (printing_id, card_id) values ('injected', 'card')",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(database.query('select * from usercards_private.import_entry')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await database.exec('reset role');
    }
  });

  it('keeps reads unavailable until explicit legacy reference preparation completes', async () => {
    const revision = (
      await userCards.query(alice, {
        scope: { kind: 'collection' },
        resultLevel: 'card',
      })
    ).privateRevision;
    await database.exec('delete from usercards_private.printing_reference');
    await database.exec(
      `update catalog_private.printing set current = false;
       update catalog_private.card_name set current = false;
       update catalog_private.card set current = false`,
    );

    const readOnly = createUserCardsQueries({
      sql: {
        query: database.sql.query,
        transaction(work) {
          return database.sql.transaction((statements) => {
            const readOnlyStatements = {
              query(statement: string, parameters = {}) {
                if (!/^\s*(select|with)\b/i.test(statement)) {
                  throw new Error('Query capability attempted a write.');
                }
                return statements.query(statement, parameters);
              },
            };
            return work(readOnlyStatements);
          });
        },
      },
    });
    const unavailable = await captureUserCardsError(
      readOnly.query(alice, { scope: { kind: 'collection' }, resultLevel: 'card' }),
    );
    expect(unavailable.code).toBe('unavailable');
    expect(await database.query('select * from usercards_private.printing_reference')).toEqual([]);

    let interrupt = true;
    const interruptedPreparation = createUserCardsReferencePreparation({
      sql: {
        query: database.sql.query,
        transaction(work) {
          return database.sql.transaction((statements) =>
            work({
              query(statement, parameters) {
                if (
                  interrupt &&
                  statement.includes('insert into usercards_private.printing_reference')
                ) {
                  interrupt = false;
                  throw new Error('simulated preparation interruption');
                }
                return statements.query(statement, parameters);
              },
            }),
          );
        },
      },
      catalog: createCatalog({ sql: database.sql }),
    });
    const interrupted = await captureUserCardsError(interruptedPreparation.prepare(alice));
    expect(interrupted.code).toBe('unavailable');
    expect(await database.query('select * from usercards_private.printing_reference')).toEqual([]);

    const preparation = createUserCardsReferencePreparation({
      sql: database.sql,
      catalog: createCatalog({ sql: database.sql }),
    });
    await expect(preparation.prepare(alice)).resolves.toEqual({
      preparedReferences: 2,
      complete: true,
    });
    const prepared = await readOnly.query(alice, {
      scope: { kind: 'collection' },
      resultLevel: 'card',
    });
    expect(prepared.entries).toHaveLength(2);
    expect(prepared.privateRevision).toBe(revision);
    expect(
      await database.query(
        'select printing_id, card_id from usercards_private.printing_reference order by printing_id',
      ),
    ).toEqual([
      { printing_id: boltM11.printingId, card_id: bolt.cardId },
      { printing_id: optDom.printingId, card_id: opt.cardId },
    ]);
    await expect(
      readOnly.query(alice, { scope: { kind: 'collection' }, resultLevel: 'card' }),
    ).resolves.toMatchObject({ privateRevision: revision });
    await expect(preparation.prepare(alice)).resolves.toEqual({
      preparedReferences: 0,
      complete: true,
    });
  });

  it('never resolves or writes while reporting unavailable legacy references', async () => {
    await database.exec('delete from usercards_private.printing_reference');
    const readOnly = createUserCardsQueries({ sql: database.sql });
    const error = await captureUserCardsError(
      readOnly.query(alice, { scope: { kind: 'collection' }, resultLevel: 'card' }),
    );
    expect(error.code).toBe('unavailable');
    expect(await database.query('select * from usercards_private.printing_reference')).toEqual([]);
  });
});
