/**
 * Integration scope: Search's projection storage and its published read surface against real
 * PostgreSQL semantics (docs/search.md#internal-design, docs/data-architecture.md#access-and-deployment).
 * A replacement storage runs these cases against its own provisioned database: exactly the declared
 * relations and columns, an indexing role that maintains Search's projection and reaches no
 * provider relation, a query role that reads the published views only, and a private projection
 * that returns one account's rows only inside the scope bound to the read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalogSynchronizer } from '../../src/catalog/index.js';
import {
  SEARCH_PROJECTION_SURFACE,
  searchIndexingGrants,
  searchReaderGrants,
  type SearchColumnType,
} from '../../src/search/index.js';
import type { TrustedUserContext } from '../../src/usercards/index.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';
import { readScopedProjection } from '../support/search-projection.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const boltRecord = {
  object: 'card',
  id: 'printing-m11-149-en',
  oracle_id: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  lang: 'en',
  set: 'm11',
  collector_number: '149',
  finishes: ['nonfoil', 'foil'],
  nonfoil: true,
  foil: true,
  digital: false,
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  type_line: 'Instant',
  colors: ['R'],
  color_identity: ['R'],
  cmc: 1,
};

function declaredColumns(
  relation: (typeof SEARCH_PROJECTION_SURFACE.relations)[keyof typeof SEARCH_PROJECTION_SURFACE.relations],
) {
  return relation.columns.map((column) => ({ name: column.name, type: column.type }));
}

function columnType(dataType: string, udtName: string): SearchColumnType {
  if (dataType === 'text') {
    return 'text';
  }
  if (dataType === 'ARRAY' && udtName === '_text') {
    return 'text-array';
  }
  if (dataType === 'boolean' || dataType === 'numeric' || dataType === 'integer') {
    return dataType;
  }
  throw new Error(`Undeclared Search column type ${dataType} (${udtName}).`);
}

describe('search projection surface', () => {
  let database: SearchTestDatabase;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  it('publishes exactly the declared relations and columns', async () => {
    const rows = await database.query(
      `select table_name, column_name, data_type, udt_name
       from information_schema.columns
       where table_schema = 'search'
       order by table_name, ordinal_position`,
    );

    const actual = new Map<string, { name: string; type: SearchColumnType }[]>();
    for (const row of rows) {
      const relation = `search.${String(row.table_name)}`;
      const columns = actual.get(relation) ?? [];
      columns.push({
        name: String(row.column_name),
        type: columnType(String(row.data_type), String(row.udt_name)),
      });
      actual.set(relation, columns);
    }

    const declared = Object.values(SEARCH_PROJECTION_SURFACE.relations)
      .map((relation) => [relation.name, declaredColumns(relation)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect([...actual.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual(
      declared,
    );
  });

  it('grants the indexing role its own projection and the query role the published views only', async () => {
    await database.exec('create role keeper_search_indexer');
    await database.exec('create role keeper_search_reader');
    await database.exec(searchIndexingGrants('keeper_search_indexer'));
    await database.exec(searchReaderGrants('keeper_search_reader'));
    expect(() => searchIndexingGrants('indexer"; drop schema search; --')).toThrow(TypeError);
    expect(() => searchReaderGrants('reader"; drop schema search; --')).toThrow(TypeError);

    await database.exec('set role keeper_search_indexer');
    try {
      // The indexing role maintains Search's own projection...
      await database.query(
        `insert into search_private.generation (state, published_at)
         values ('published', now())`,
      );
      // ...and reaches neither the Catalog nor the UserCards published relations.
      await expect(database.query('select card_id from catalog.cards')).rejects.toThrow(
        /permission denied/,
      );
      await expect(database.query('select copy_id from usercards.copies')).rejects.toThrow(
        /permission denied/,
      );
      await expect(database.query('select printing_id from catalog.printings')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.exec(
          `insert into catalog.cards (card_id, name, colors, color_identity)
           values ('oracle-injected', 'Injected', '{}', '{}')`,
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }

    const generator = await database.query(
      `select generation_id::text as generation_id from search_private.generation`,
    );
    const generation = String(generator[0]?.generation_id);
    await database.query(
      `insert into search_private.card
         (generation_id, card_id, name, colors, color_identity)
       values ($1, 'oracle-lightning-bolt', 'Lightning Bolt', '{R}', '{R}')`,
      [generation],
    );
    await database.query(
      `insert into search_private.catalog_checkpoint (generation_id, position, revision_id)
       values ($1, '10', 'revision-1')`,
      [generation],
    );

    await database.exec('set role keeper_search_reader');
    try {
      for (const relation of Object.values(SEARCH_PROJECTION_SURFACE.relations)) {
        await database.query(`select * from ${relation.name}`);
      }
      await expect(database.query('select card_id from search_private.card')).rejects.toThrow(
        /permission denied/,
      );
      // Search's query grant reaches its own published views, never a provider relation.
      await expect(database.query('select card_id from catalog.cards')).rejects.toThrow(
        /permission denied/,
      );
      await expect(database.query('select copy_id from usercards.copies')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.exec(
          `insert into search.cards (card_id, name, colors, color_identity)
           values ('oracle-injected', 'Injected', '{}', '{}')`,
        ),
      ).rejects.toThrow(/permission denied/);
      // The reader sees the published generation's catalog facts.
      expect(await database.query('select card_id from search.cards')).toEqual([
        { card_id: 'oracle-lightning-bolt' },
      ]);
    } finally {
      await database.exec('reset role');
    }
  });

  it('scopes the private projection to the account bound to the read', async () => {
    const synchronizer = createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: { sourceVersion: 'snapshot-1', records: [boltRecord] },
      }),
    });
    await synchronizer.synchronize({ dataset: 'cards' });
    await database.userCards.createCopies(alice, {
      printingId: 'printing-m11-149-en',
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 2,
    });
    await database.userCards.createCopies(bob, {
      printingId: 'printing-m11-149-en',
      finish: 'foil',
      condition: null,
      quantity: 1,
    });
    const tag = await database.userCards.createTag(alice, { kind: 'wishlist', label: 'Wishlist' });
    await database.userCards.createAssociation(alice, {
      tagId: tag.tag.tagId,
      targetLevel: 'card',
      targetId: 'oracle-lightning-bolt',
      quantity: 3,
    });
    await database.indexer.index({ accounts: [alice.accountId, bob.accountId] });

    // Every account-scoped relation answers for the bound account and for no other one.
    for (const relation of Object.values(SEARCH_PROJECTION_SURFACE.relations)) {
      const scoped = await readScopedProjection(
        database,
        alice.accountId,
        `select * from ${relation.name}`,
      );
      if (relation.accountScoped) {
        expect(scoped.length, relation.name).toBeGreaterThan(0);
      }
      const unbound = await database.query(`select * from ${relation.name}`);
      if (relation.accountScoped) {
        expect(unbound, relation.name).toEqual([]);
      }
    }
    expect(
      await readScopedProjection(database, bob.accountId, 'select copy_id from search.copies'),
    ).toHaveLength(1);
    expect(await database.query('select card_id from search.cards')).toEqual([
      { card_id: 'oracle-lightning-bolt' },
    ]);
  });
});
