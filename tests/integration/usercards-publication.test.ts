/**
 * Integration scope: the UserCards publication contract against real PostgreSQL semantics and
 * grants. A replacement storage runs these same cases against its own provisioned database: the
 * durable stream carries one account's changes and positions only, a trusted indexing role reads
 * the publication contract without reaching the private records behind it, an end-user read role
 * reaches neither the stream nor another account's position, and reusing one connection for
 * another account's snapshot leaks nothing of the first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/catalog/index.js';
import {
  USERCARDS_ACCOUNT_SCOPE_SQL,
  createUserCards,
  createUserCardsPublication,
  usercardsPublicationGrants,
  usercardsReaderGrants,
  type PhysicalCopy,
  type TrustedUserContext,
  type UserCards,
  type UserCardsPublication,
  type UserCardsPublishedRecord,
} from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../support/usercards-database.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const m11Printing = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

describe('usercards publication over real storage', () => {
  let database: UserCardsTestDatabase;
  let userCards: UserCards;
  let publication: UserCardsPublication;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing],
    });
    userCards = createUserCards({
      sql: database.sql,
      catalog: createCatalog({ sql: database.sql }),
    });
    publication = createUserCardsPublication({ sql: database.sql });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(context: TrustedUserContext): Promise<PhysicalCopy> {
    const created = await userCards.createCopies(context, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    return created.copies[0] as PhysicalCopy;
  }

  function copyIds(records: readonly UserCardsPublishedRecord[]): readonly string[] {
    return records
      .filter((record) => record.kind === 'copy')
      .map((record) => (record.kind === 'copy' ? record.copy.copyId : ''));
  }

  it('grants trusted indexing access to the publication and not to the private records', async () => {
    const aliceCopy = await createCopy(alice);
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const association = await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    await database.exec('create role keeper_indexer');
    await database.exec('create role keeper_reader');
    await database.exec(usercardsPublicationGrants('keeper_indexer'));
    await database.exec(usercardsReaderGrants('keeper_reader'));
    expect(() => usercardsPublicationGrants('indexer"; drop schema usercards; --')).toThrow(
      TypeError,
    );
    expect(() => usercardsReaderGrants('Indexer')).toThrow(TypeError);

    await database.exec('set role keeper_indexer');
    try {
      const snapshot = await publication.readSnapshot({
        accountId: alice.accountId,
        pageSize: 10,
      });
      expect(snapshot.position).toBe(association.publicationPosition);
      expect(copyIds(snapshot.records)).toEqual([aliceCopy.copyId]);
      const changes = await publication.readChanges({
        accountId: alice.accountId,
        position: '0',
        pageSize: 10,
      });
      expect(changes.position).toBe(snapshot.position);
      expect(changes.changes.at(-1)).toMatchObject({ kind: 'revision' });

      await expect(database.query('select copy_id from usercards_private.copy')).rejects.toThrow(
        /permission denied/,
      );
      await expect(database.query('select tag_id from usercards_private.tag')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.query('select association_id from usercards_private.association'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.exec(
          `insert into usercards_private.publication (account_id, revision, kind)
           values ('injected', 1, 'revision')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.exec('update usercards_private.account_state set expired_below = 0'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }

    await database.exec('set role keeper_reader');
    try {
      // The end-user role reads the published relations and never the durable stream.
      expect(
        await database.sql.transaction(async (statements) => {
          await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
          return statements.query('select copy_id from usercards.copies');
        }),
      ).toEqual([{ copy_id: aliceCopy.copyId }]);
      await expect(
        database.query('select position from usercards_private.publication'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.query('select revision from usercards_private.account_state'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }
  });

  it('publishes each account its own records and positions on a reused connection', async () => {
    const aliceCopy = await createCopy(alice);
    const bobCopy = await createCopy(bob);

    const aliceSnapshot = await publication.readSnapshot({ accountId: alice.accountId });
    const bobSnapshot = await publication.readSnapshot({ accountId: bob.accountId });
    expect(aliceSnapshot.position).toBe(await publishedPosition(alice.accountId));
    expect(bobSnapshot.position).toBe(await publishedPosition(bob.accountId));
    expect(copyIds(aliceSnapshot.records)).toEqual([aliceCopy.copyId]);
    expect(copyIds(bobSnapshot.records)).toEqual([bobCopy.copyId]);

    // The same connection reads Alice again after Bob's snapshot: nothing of either read leaks
    // into the other, and both accounts resume from their own positions.
    const again = await publication.readSnapshot({ accountId: alice.accountId });
    expect(again).toEqual(aliceSnapshot);
    const aliceChanges = await publication.readChanges({
      accountId: alice.accountId,
      position: '0',
      pageSize: 100,
    });
    expect(aliceChanges.changes.every((change) => change.accountId === alice.accountId)).toBe(true);
    expect(
      aliceChanges.changes.some(
        (change) =>
          change.kind === 'copy' &&
          change.reference.kind === 'copy' &&
          change.reference.copyId === bobCopy.copyId,
      ),
    ).toBe(false);

    // Bob's position is not part of Alice's history, so Alice's stream fails closed rather than
    // pretending to continue from it.
    expect(
      await captureUserCardsError(
        publication.readChanges({
          accountId: alice.accountId,
          position: bobSnapshot.position,
        }),
      ),
    ).toMatchObject({ code: 'stale-continuation' });

    // A fresh reader observes the same account’s records and positions.
    const reopened = createUserCardsPublication({ sql: database.sql });
    expect(await reopened.readSnapshot({ accountId: alice.accountId })).toEqual(aliceSnapshot);
  });

  async function publishedPosition(accountId: string): Promise<string> {
    const rows = await database.query(
      `select max(position)::text as position
         from usercards_private.publication
        where account_id = $1 and kind = 'revision'`,
      [accountId],
    );
    return String(rows[0]?.position);
  }
});
