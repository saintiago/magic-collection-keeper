/** Account isolation and read-only access of UserCards current-query views on PostgreSQL. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_ACCOUNT_SCOPE_SQL,
  usercardsQueryGrants,
  usercardsSchemaSql,
  type PhysicalCopy,
  type TrustedUserContext,
  type UserCards,
  type UserCardsSqlRow,
} from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import {
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

/** Reads one relation with the account scope bound inside the transaction, like Application does. */
async function readScoped(
  database: UserCardsTestDatabase,
  accountId: string,
  statement: string,
): Promise<readonly UserCardsSqlRow[]> {
  return database.sql.transaction(async (statements) => {
    await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
    return statements.query(statement);
  });
}

describe('usercards query surface', () => {
  let database: UserCardsTestDatabase;
  let userCards: UserCards;

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
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(
    context: TrustedUserContext,
    overrides: { finish?: 'nonfoil' | 'foil'; condition?: 'NM' | 'LP' | null } = {},
  ): Promise<PhysicalCopy> {
    const created = await userCards.createCopies(context, {
      printingId: m11Printing.printingId,
      finish: overrides.finish ?? 'nonfoil',
      condition: overrides.condition === undefined ? 'NM' : overrides.condition,
      quantity: 1,
    });
    return created.copies[0] as PhysicalCopy;
  }

  it('grants consumer roles read-only access to the account-scoped views and no private tables', async () => {
    const aliceCopy = await createCopy(alice, { finish: 'foil', condition: 'LP' });
    await createCopy(bob, { finish: 'nonfoil', condition: null });
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const association = await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    await database.exec('create role keeper_reader');
    await database.exec(usercardsQueryGrants('keeper_reader'));
    expect(() => usercardsQueryGrants('reader"; drop schema usercards; --')).toThrow(TypeError);

    await database.exec('set role keeper_reader');
    try {
      const copies = await readScoped(
        database,
        alice.accountId,
        'select copy_id, printing_id, finish, condition from usercards_current_query.copy order by copy_id',
      );
      expect(copies).toEqual([
        {
          copy_id: aliceCopy.copyId,
          printing_id: aliceCopy.printingId,
          finish: 'foil',
          condition: 'LP',
        },
      ]);
      const revision = await readScoped(
        database,
        alice.accountId,
        'select revision::text as revision from usercards_current_query.account_state',
      );
      // Alice's copy, tag and association are three private changes.
      expect(revision).toEqual([{ revision: '3' }]);

      expect(
        await readScoped(
          database,
          alice.accountId,
          'select tag_id, kind, label, system from usercards_current_query.tag order by kind',
        ),
      ).toEqual([
        { tag_id: deck.tag.tagId, kind: 'deck', label: 'Burn', system: false },
        { tag_id: expect.any(String) as string, kind: 'owned', label: 'Owned', system: true },
      ]);
      expect(
        await readScoped(
          database,
          alice.accountId,
          `select association_id, tag_id, target_level, target_id, quantity
             from usercards_current_query.association
            where target_level <> 'copy'`,
        ),
      ).toEqual([
        {
          association_id: association.association.associationId,
          tag_id: deck.tag.tagId,
          target_level: 'card',
          target_id: lightningBolt.cardId,
          quantity: 4,
        },
      ]);

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
          "insert into usercards_current_query.copy (copy_id) values ('copy-injected')",
        ),
      ).rejects.toThrow(/permission denied|cannot insert into view/);
      await expect(
        database.exec(
          "insert into usercards_current_query.association (association_id) values ('injected')",
        ),
      ).rejects.toThrow(/permission denied|cannot insert into view/);
    } finally {
      await database.exec('reset role');
    }
  });

  it('keeps consumer predicates from evaluating the rows the account filter excludes', async () => {
    const aliceCopy = await createCopy(alice);
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const association = await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    await database.exec('create role keeper_prober');
    await database.exec(usercardsQueryGrants('keeper_prober'));
    await database.exec('set role keeper_prober');
    try {
      // Both probes force a sequential plan: there the predicate would run over the base rows and
      // a failing cast would quote Alice's private identity without the security barrier.
      async function probe(
        accountId: string | null,
        statement: string,
      ): Promise<readonly UserCardsSqlRow[]> {
        return database.sql.transaction(async (statements) => {
          await statements.query('set local enable_indexscan = off');
          await statements.query('set local enable_bitmapscan = off');
          if (accountId !== null) {
            await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
          }
          return statements.query(statement);
        });
      }

      const copyProbe = 'select copy_id from usercards_current_query.copy where copy_id::boolean';
      const associationProbe =
        'select association_id from usercards_current_query.association where association_id::boolean';
      await expect(probe(bob.accountId, copyProbe)).resolves.toEqual([]);
      await expect(probe(null, copyProbe)).resolves.toEqual([]);
      await expect(probe(bob.accountId, associationProbe)).resolves.toEqual([]);
      await expect(probe(null, associationProbe)).resolves.toEqual([]);

      // The same reader sees Alice's records with Alice's account bound, so the empty probes above
      // come from the account filter and not from a relation that never returns rows.
      expect(
        await database.sql.transaction(async (statements) => {
          await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
          return statements.query('select copy_id from usercards_current_query.copy');
        }),
      ).toEqual([{ copy_id: aliceCopy.copyId }]);
      expect(
        await readScoped(
          database,
          alice.accountId,
          `select association_id from usercards_current_query.association where target_level = 'card'`,
        ),
      ).toEqual([{ association_id: association.association.associationId }]);
    } finally {
      await database.exec('reset role');
    }
  });

  it('fails closed while no account context is bound', async () => {
    await createCopy(alice);
    await createCopy(bob);
    await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });

    expect(await database.query('select * from usercards_current_query.copy')).toEqual([]);
    expect(await database.query('select * from usercards_current_query.tag')).toEqual([]);
    expect(await database.query('select * from usercards_current_query.association')).toEqual([]);
    expect(await database.query('select * from usercards_current_query.account_state')).toEqual([]);
  });

  it('keeps the account scope from leaking between transactions on a reused connection', async () => {
    const aliceCopy = await createCopy(alice);
    const bobCopy = await createCopy(bob, { condition: 'LP' });
    await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    await userCards.createTag(bob, { kind: 'wishlist', label: 'Wanted' });

    const scopedForAlice = await readScoped(
      database,
      alice.accountId,
      'select copy_id from usercards_current_query.copy',
    );
    expect(scopedForAlice).toEqual([{ copy_id: aliceCopy.copyId }]);
    expect(
      await readScoped(
        database,
        alice.accountId,
        'select kind, label from usercards_current_query.tag order by kind',
      ),
    ).toEqual([
      { kind: 'deck', label: 'Burn' },
      { kind: 'owned', label: 'Owned' },
    ]);
    expect(
      await readScoped(
        database,
        bob.accountId,
        'select label from usercards_current_query.tag order by label',
      ),
    ).toEqual([{ label: 'Owned' }, { label: 'Wanted' }]);

    // The transaction ended, so the same connection is unscoped again: nothing leaks out of it.
    expect(await database.query('select copy_id from usercards_current_query.copy')).toEqual([]);
    expect(await database.query('select tag_id from usercards_current_query.tag')).toEqual([]);
    expect(
      await database.query('select association_id from usercards_current_query.association'),
    ).toEqual([]);
    expect(
      await database.query(
        'select revision::text as revision from usercards_current_query.account_state',
      ),
    ).toEqual([]);

    // Binding without a transaction is transaction-local too: the next statement fails closed. A
    // released setting stays defined as an empty string, which the views treat as no context.
    await database.sql.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
    expect(await database.query('select copy_id from usercards_current_query.copy')).toEqual([]);
    expect(await database.query('select tag_id from usercards_current_query.tag')).toEqual([]);
    expect(
      await database.query(
        'select revision::text as revision from usercards_current_query.account_state',
      ),
    ).toEqual([]);

    const scopedForBob = await readScoped(
      database,
      bob.accountId,
      'select copy_id, finish, condition from usercards_current_query.copy',
    );
    expect(scopedForBob).toEqual([{ copy_id: bobCopy.copyId, finish: 'nonfoil', condition: 'LP' }]);
  });

  it('reapplies the owner schema over the installed view shape without changing copies', async () => {
    const copy = await createCopy(alice);
    // The previous implementation exposed this retention column in the existing view.
    await database.exec(`alter table usercards_private.account_state add column expired_below bigint not null default 7;
      create or replace view usercards_current_query.account_state with (security_barrier) as
      select account_id, revision, expired_below from usercards_private.account_state
      where account_id = nullif(current_setting('usercards.account_id', true), '')`);
    await database.exec(usercardsSchemaSql);
    await database.exec(usercardsSchemaSql);
    expect((await userCards.readCopies(alice, [copy.copyId])).copies.get(copy.copyId)).toEqual(
      copy,
    );
    expect(
      await readScoped(
        database,
        alice.accountId,
        'select revision::text as revision from usercards_current_query.account_state',
      ),
    ).toEqual([{ revision: '1' }]);
  });
});
