/**
 * Integration scope: the catalog query surface against real PostgreSQL semantics. A replacement
 * storage runs these same cases against its own provisioned database: the declared relations and
 * columns, read-only access for consumer roles, records and revisions read from real writes, and
 * one mutually consistent published revision. The identity constraints below exercise this
 * provider's storage mapping.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATALOG_QUERY_SURFACE,
  catalogReaderGrants,
  createCatalog,
  type CatalogColumnType,
} from '../../src/catalog/index.js';
import {
  createCatalogTestDatabase,
  publishCatalog,
  type CatalogTestDatabase,
} from '../support/catalog-database.js';

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  names: [
    { language: 'de', name: 'Blitzschlag' },
    { language: 'ja', name: '稲妻' },
    { language: 'es', name: 'Relámpago' },
  ],
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
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

const staPrinting = {
  printingId: 'printing-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: false,
};

function declaredColumns(
  relation: (typeof CATALOG_QUERY_SURFACE.relations)[keyof typeof CATALOG_QUERY_SURFACE.relations],
) {
  return relation.columns.map((column) => ({
    name: column.name,
    type: column.type,
  }));
}

function columnType(dataType: string, udtName: string): CatalogColumnType {
  if (dataType === 'text') {
    return 'text';
  }
  if (dataType === 'ARRAY' && udtName === '_text') {
    return 'text-array';
  }
  if (dataType === 'boolean') {
    return 'boolean';
  }
  if (dataType === 'numeric') {
    return 'numeric';
  }
  if (dataType === 'timestamp with time zone') {
    return 'timestamp';
  }
  throw new Error(`Undeclared catalog column type ${dataType} (${udtName}).`);
}

describe('catalog query surface', () => {
  let database: CatalogTestDatabase;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  it('publishes exactly the declared relations and columns', async () => {
    // PostgreSQL does not expose nullability for view columns, so this contract test compares
    // names, order and types. Declared nullability is enforced when Catalog reads a revision: a
    // published value that puts null in a non-nullable column fails the read as unavailable.
    const rows = await database.query(
      `select table_name, column_name, data_type, udt_name
       from information_schema.columns
       where table_schema = 'catalog'
       order by table_name, ordinal_position`,
    );

    const actual = new Map<string, { name: string; type: CatalogColumnType }[]>();
    for (const row of rows) {
      const relation = `catalog.${String(row.table_name)}`;
      const columns = actual.get(relation) ?? [];
      columns.push({
        name: String(row.column_name),
        type: columnType(String(row.data_type), String(row.udt_name)),
      });
      actual.set(relation, columns);
    }

    const declared = Object.values(CATALOG_QUERY_SURFACE.relations)
      .map((relation) => [relation.name, declaredColumns(relation)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    expect([...actual.entries()].sort(([left], [right]) => left.localeCompare(right))).toEqual(
      declared,
    );
  });

  it('grants consumer roles read-only access to the published views and no private tables', async () => {
    await database.exec('create role keeper_reader');
    await database.exec(catalogReaderGrants('keeper_reader'));
    expect(() => catalogReaderGrants('reader"; drop schema catalog; --')).toThrow(TypeError);

    await database.exec('set role keeper_reader');
    try {
      for (const relation of Object.values(CATALOG_QUERY_SURFACE.relations)) {
        await database.query(`select * from ${relation.name}`);
      }
      await expect(database.query('select card_id from catalog_private.card')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.query('select revision_id from catalog_private.revision'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.exec(
          `insert into catalog.cards (card_id, name, colors, color_identity)
           values ('oracle-injected', 'Injected', '{}', '{}')`,
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }
  });

  it('keeps card and printing identities unique and aliases from multiplying card counts', async () => {
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing, staPrinting],
    });

    await expect(
      database.query(
        `insert into catalog_private.card (card_id, name, colors, color_identity)
         values ($1, 'Duplicate', '{}', '{}')`,
        [lightningBolt.cardId],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      database.query(
        `insert into catalog_private.printing
           (printing_id, card_id, edition, collector_number, language, finishes, physical)
         values ($1, $2, 'M11', '149', 'en', '{nonfoil}', true)`,
        [m11Printing.printingId, lightningBolt.cardId],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      database.query(
        `insert into catalog_private.printing
           (printing_id, card_id, edition, collector_number, language, finishes, physical)
         values ('printing-orphan', 'oracle-missing', 'M11', '149', 'en', '{nonfoil}', true)`,
      ),
    ).rejects.toThrow(/foreign key/);

    const counts = await database.query(
      `select (select count(*)::int from catalog.cards) as cards,
              (select count(*)::int from catalog.card_names) as names,
              (select count(distinct card_id)::int from catalog.card_names) as named_cards,
              (select count(*)::int from catalog.printings) as printings`,
    );
    expect(counts[0]).toEqual({ cards: 1, names: 3, named_cards: 1, printings: 2 });
  });

  it('exposes one mutually consistent revision and keeps the previous one after a failed publish', async () => {
    const catalog = createCatalog({ sql: database.sql });
    await publishCatalog(database, {
      revisionId: 'revision-a',
      cards: [{ cardId: 'oracle-a', name: 'Card A' }],
      printings: [
        {
          printingId: 'printing-a',
          cardId: 'oracle-a',
          edition: 'TST',
          collectorNumber: '1',
          language: 'en',
        },
      ],
    });

    const published = await catalog.resolve([
      { kind: 'card', cardId: 'oracle-a' },
      { kind: 'printing', printingId: 'printing-a' },
    ]);
    expect(published.revision.revisionId).toBe('revision-a');
    expect(published.cards.size).toBe(1);
    expect(published.printings.size).toBe(1);

    await database.exec('begin');
    await database.exec(
      'delete from catalog_private.card_name; delete from catalog_private.printing; delete from catalog_private.card;',
    );
    await database.query(
      `insert into catalog_private.card (card_id, name, colors, color_identity)
       values ('oracle-b', 'Card B', '{}', '{}')`,
    );
    await database.query(
      `insert into catalog_private.printing
         (printing_id, card_id, edition, collector_number, language, finishes, physical)
       values ('printing-b', 'oracle-b', 'TST', '2', 'en', '{nonfoil}', true)`,
    );
    await database.query(
      `update catalog_private.revision set revision_id = 'revision-b', published_at = now()`,
    );
    await database.exec('commit');

    const replaced = await catalog.resolve([
      { kind: 'card', cardId: 'oracle-a' },
      { kind: 'card', cardId: 'oracle-b' },
    ]);
    expect(replaced.revision.revisionId).toBe('revision-b');
    expect(replaced.missing).toEqual([{ kind: 'card', cardId: 'oracle-a' }]);
    expect(replaced.cards.get('oracle-b')?.name).toBe('Card B');

    await database.exec('begin');
    await database.query(
      `update catalog_private.revision set revision_id = 'revision-c', published_at = now()`,
    );
    await database.exec('delete from catalog_private.printing');
    await database.exec('rollback');

    const preserved = await catalog.resolve([{ kind: 'printing', printingId: 'printing-b' }]);
    expect(preserved.revision.revisionId).toBe('revision-b');
    expect(preserved.printings.get('printing-b')?.cardId).toBe('oracle-b');
  });
});
