/**
 * Integration scope: the UserCards query surface against real PostgreSQL semantics. A replacement
 * storage runs these same cases against its own provisioned database: the declared relations and
 * columns, read-only access for consumer roles, account scoping enforced at the database boundary,
 * consumer predicates that cannot observe the rows the scope excludes, one account's scope never
 * leaking into another transaction on a reused connection, and a private-data revision that
 * follows the account's real writes. Two synthetic accounts stand in for distinct authenticated
 * users.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog } from '../../src/catalog/index.js';
import {
  createUserCards,
  USERCARDS_ACCOUNT_SCOPE_SQL,
  USERCARDS_QUERY_SURFACE,
  usercardsReaderGrants,
  type PhysicalCopy,
  type TrustedUserContext,
  type UserCards,
  type UserCardsColumnType,
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

function declaredColumns(
  relation: (typeof USERCARDS_QUERY_SURFACE.relations)[keyof typeof USERCARDS_QUERY_SURFACE.relations],
) {
  return relation.columns.map((column) => ({ name: column.name, type: column.type }));
}

function columnType(dataType: string): UserCardsColumnType {
  if (dataType === 'text') {
    return 'text';
  }
  throw new Error(`Undeclared UserCards column type ${dataType}.`);
}

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

  it('publishes exactly the declared relations and columns', async () => {
    // PostgreSQL does not expose nullability for view columns, so this contract test compares
    // names, order and types. Declared nullability is enforced when UserCards reads the relation.
    const rows = await database.query(
      `select table_name, column_name, data_type
       from information_schema.columns
       where table_schema = 'usercards'
       order by table_name, ordinal_position`,
    );

    const actual = new Map<string, { name: string; type: UserCardsColumnType }[]>();
    for (const row of rows) {
      const relation = `usercards.${String(row.table_name)}`;
      const columns = actual.get(relation) ?? [];
      columns.push({
        name: String(row.column_name),
        type: columnType(String(row.data_type)),
      });
      actual.set(relation, columns);
    }

    const declared = Object.values(USERCARDS_QUERY_SURFACE.relations)
      .map((relation) => [relation.name, declaredColumns(relation)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect([...actual.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual(
      declared,
    );
  });

  it('grants consumer roles read-only access to the account-scoped views and no private tables', async () => {
    const aliceCopy = await createCopy(alice, { finish: 'foil', condition: 'LP' });
    await createCopy(bob, { finish: 'nonfoil', condition: null });

    await database.exec('create role keeper_reader');
    await database.exec(usercardsReaderGrants('keeper_reader'));
    expect(() => usercardsReaderGrants('reader"; drop schema usercards; --')).toThrow(TypeError);

    await database.exec('set role keeper_reader');
    try {
      const copies = await readScoped(
        database,
        alice.accountId,
        'select copy_id, printing_id, finish, condition from usercards.copies order by copy_id',
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
        'select revision from usercards.private_revision',
      );
      expect(revision).toEqual([{ revision: '1' }]);

      await expect(database.query('select copy_id from usercards_private.copy')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.exec("insert into usercards.copies (copy_id) values ('copy-injected')"),
      ).rejects.toThrow(/permission denied|cannot insert into a view/);
    } finally {
      await database.exec('reset role');
    }
  });

  it('keeps consumer predicates from evaluating the rows the account filter excludes', async () => {
    const aliceCopy = await createCopy(alice);

    await database.exec('create role keeper_prober');
    await database.exec(usercardsReaderGrants('keeper_prober'));
    await database.exec('set role keeper_prober');
    try {
      // Both probes force a sequential plan: there the predicate would run over the base rows and
      // a failing cast would quote Alice's private copy ID without the security barrier.
      async function probe(accountId: string | null): Promise<readonly UserCardsSqlRow[]> {
        return database.sql.transaction(async (statements) => {
          await statements.query('set local enable_indexscan = off');
          await statements.query('set local enable_bitmapscan = off');
          if (accountId !== null) {
            await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: accountId });
          }
          return statements.query('select copy_id from usercards.copies where copy_id::boolean');
        });
      }

      await expect(probe(bob.accountId)).resolves.toEqual([]);
      await expect(probe(null)).resolves.toEqual([]);

      // The same reader sees Alice's copy with Alice's account bound, so the empty probes above
      // come from the account filter and not from a relation that never returns rows.
      expect(
        await database.sql.transaction(async (statements) => {
          await statements.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
          return statements.query('select copy_id from usercards.copies');
        }),
      ).toEqual([{ copy_id: aliceCopy.copyId }]);
    } finally {
      await database.exec('reset role');
    }
  });

  it('fails closed while no account context is bound', async () => {
    await createCopy(alice);
    await createCopy(bob);

    expect(await database.query('select * from usercards.copies')).toEqual([]);
    expect(await database.query('select * from usercards.private_revision')).toEqual([]);
  });

  it('keeps the account scope from leaking between transactions on a reused connection', async () => {
    const aliceCopy = await createCopy(alice);
    const bobCopy = await createCopy(bob, { condition: 'LP' });

    const scopedForAlice = await readScoped(
      database,
      alice.accountId,
      'select copy_id from usercards.copies',
    );
    expect(scopedForAlice).toEqual([{ copy_id: aliceCopy.copyId }]);

    // The transaction ended, so the same connection is unscoped again: nothing leaks out of it.
    expect(await database.query('select copy_id from usercards.copies')).toEqual([]);
    expect(await database.query('select revision from usercards.private_revision')).toEqual([]);

    // Binding without a transaction is transaction-local too: the next statement fails closed. A
    // released setting stays defined as an empty string, which the views treat as no context.
    await database.sql.query(USERCARDS_ACCOUNT_SCOPE_SQL, { account_id: alice.accountId });
    expect(await database.query('select copy_id from usercards.copies')).toEqual([]);
    expect(await database.query('select revision from usercards.private_revision')).toEqual([]);

    const scopedForBob = await readScoped(
      database,
      bob.accountId,
      'select copy_id, finish, condition from usercards.copies',
    );
    expect(scopedForBob).toEqual([{ copy_id: bobCopy.copyId, finish: 'nonfoil', condition: 'LP' }]);
  });

  it('joins both published surfaces for one account in a single scoped query', async () => {
    const aliceCopy = await createCopy(alice, { finish: 'foil' });
    await createCopy(bob);

    // Search composes the provider views in one statement under one bound account.
    const rows = await readScoped(
      database,
      alice.accountId,
      `select copies.copy_id, printings.edition, printings.collector_number,
              copies.finish, copies.condition
         from usercards.copies as copies
         join catalog.printings as printings on printings.printing_id = copies.printing_id
        order by copies.copy_id`,
    );

    expect(rows).toEqual([
      {
        copy_id: aliceCopy.copyId,
        edition: 'M11',
        collector_number: '149',
        finish: 'foil',
        condition: 'NM',
      },
    ]);
  });

  it('publishes a private-data revision that advances with the account’s writes', async () => {
    const empty = await readScoped(
      database,
      alice.accountId,
      'select revision from usercards.private_revision',
    );
    expect(empty).toEqual([{ revision: '0' }]);

    const copy = await createCopy(alice);
    expect(
      await readScoped(
        database,
        alice.accountId,
        'select revision from usercards.private_revision',
      ),
    ).toEqual([{ revision: '1' }]);

    await userCards.correctCopy(alice, {
      copyId: copy.copyId,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'HP',
    });
    expect(
      await readScoped(
        database,
        alice.accountId,
        'select revision from usercards.private_revision',
      ),
    ).toEqual([{ revision: '2' }]);

    // Bob's private data has its own revision and his write does not advance Alice's.
    await createCopy(bob);
    expect(
      await readScoped(database, bob.accountId, 'select revision from usercards.private_revision'),
    ).toEqual([{ revision: '1' }]);
    expect(
      await readScoped(
        database,
        alice.accountId,
        'select revision from usercards.private_revision',
      ),
    ).toEqual([{ revision: '2' }]);
  });
});
