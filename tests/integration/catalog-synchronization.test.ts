/**
 * Integration scope: synchronization against real PostgreSQL semantics. A replacement storage runs
 * the same cases against its own provisioned database: one publication replaces the declared
 * relations and the published revision together, an interrupted publication leaves the previous
 * revision and its continuations readable, and retrying adds no duplicate identities.
 *
 * PGlite serves one connection, so concurrent readers cannot run beside a publication here.
 * Coherence is established by the publication transaction: a rollback leaves the previous
 * revision, its rows and its continuations exactly as they were, and the viewer sees the revision
 * row that belongs to those rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  catalogReaderGrants,
  createCatalog,
  createCatalogSynchronizer,
  type Catalog,
  type CatalogSqlTransactor,
} from '../../src/catalog/index.js';
import {
  captureCatalogError,
  createCatalogTestDatabase,
  type CatalogTestDatabase,
} from '../support/catalog-database.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';

function cardRecord(options: {
  readonly printingId: string;
  readonly cardId: string;
  readonly name: string;
  readonly lang?: string;
  readonly printedName?: string;
  readonly collectorNumber?: string;
  readonly oracleText?: string;
  readonly finishes?: readonly string[];
  readonly digital?: boolean;
}): Record<string, unknown> {
  return {
    object: 'card',
    id: options.printingId,
    oracle_id: options.cardId,
    name: options.name,
    lang: options.lang ?? 'en',
    set: 'tst',
    collector_number: options.collectorNumber ?? '1',
    finishes: options.finishes ?? ['nonfoil'],
    nonfoil: (options.finishes ?? ['nonfoil']).includes('nonfoil'),
    foil: (options.finishes ?? ['nonfoil']).includes('foil'),
    digital: options.digital ?? false,
    oracle_text: options.oracleText ?? 'Text',
    type_line: 'Instant',
    colors: ['R'],
    color_identity: ['R'],
    cmc: 1,
    ...(options.printedName === undefined ? {} : { printed_name: options.printedName }),
  };
}

const boltEnglish = cardRecord({
  printingId: 'printing-a-en',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  collectorNumber: '1',
  oracleText: 'Lightning Bolt deals 3 damage to any target.',
});
const boltSpanish = cardRecord({
  printingId: 'printing-a-es',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  lang: 'es',
  printedName: 'Relámpago',
  collectorNumber: '2',
});
const boltSecondEdition = cardRecord({
  printingId: 'printing-b-en',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  collectorNumber: '3',
  oracleText: 'Lightning Bolt deals 3 damage to any target.',
});

describe('catalog synchronization publication', () => {
  let database: CatalogTestDatabase;
  let catalog: Catalog;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    catalog = createCatalog({ sql: database.sql });
  });

  afterEach(async () => {
    await database.close();
  });

  it('publishes synchronized records into the declared relations for a consumer role', async () => {
    await database.exec('create role keeper_reader');
    await database.exec(catalogReaderGrants('keeper_reader'));
    await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        all_cards: {
          sourceName: 'scryfall',
          sourceVersion: 'snapshot-1',
          records: [boltEnglish, boltSpanish, boltSecondEdition],
        },
      }),
    }).synchronize({ dataset: 'all_cards' });

    await database.exec('set role keeper_reader');
    try {
      const revision = await database.query(
        'select revision_id, source_name, source_version from catalog.published_revision',
      );
      expect(revision).toHaveLength(1);
      expect(revision[0]).toMatchObject({ source_name: 'scryfall', source_version: 'snapshot-1' });

      const cards = await database.query('select card_id, name, colors from catalog.cards');
      expect(cards).toEqual([{ card_id: 'oracle-bolt', name: 'Lightning Bolt', colors: ['R'] }]);

      const names = await database.query(
        'select card_id, language, name from catalog.card_names order by language, name',
      );
      expect(names).toEqual([
        { card_id: 'oracle-bolt', language: 'en', name: 'Lightning Bolt' },
        { card_id: 'oracle-bolt', language: 'es', name: 'Relámpago' },
      ]);

      const printings = await database.query(
        'select printing_id, card_id, language, finishes, physical from catalog.printings order by printing_id',
      );
      expect(printings).toEqual([
        {
          printing_id: 'printing-a-en',
          card_id: 'oracle-bolt',
          language: 'en',
          finishes: ['nonfoil'],
          physical: true,
        },
        {
          printing_id: 'printing-a-es',
          card_id: 'oracle-bolt',
          language: 'es',
          finishes: ['nonfoil'],
          physical: true,
        },
        {
          printing_id: 'printing-b-en',
          card_id: 'oracle-bolt',
          language: 'en',
          finishes: ['nonfoil'],
          physical: true,
        },
      ]);
    } finally {
      await database.exec('reset role');
    }
  });

  it('keeps the previous revision and its continuations readable after an interrupted publication', async () => {
    const first = await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: { sourceVersion: 'snapshot-1', records: [boltEnglish, boltSecondEdition] },
      }),
    }).synchronize({ dataset: 'cards' });
    const page = await catalog.listCardPrintings('oracle-bolt', { pageSize: 1 });
    expect(page.revision).toEqual(first);
    expect(page.continuation).not.toBeNull();

    const interrupted = failAfterStatements(database.sql, 4);
    const error = await captureCatalogError(
      createCatalogSynchronizer({
        sql: interrupted,
        snapshots: createSnapshotSource({
          cards: {
            sourceVersion: 'snapshot-2',
            records: [
              { ...boltEnglish, oracle_text: 'Rewritten rules text.' },
              cardRecord({
                printingId: 'printing-c-en',
                cardId: 'oracle-interrupted',
                name: 'Interrupted Card',
              }),
            ],
          },
        }),
      }).synchronize({ dataset: 'cards' }),
    );
    expect(error.code).toBe('unavailable');

    const preserved = await catalog.listCardPrintings('oracle-bolt', {
      pageSize: 1,
      continuation: page.continuation ?? '',
    });
    expect(preserved.revision).toEqual(first);
    expect(preserved.printings.map((printing) => printing.printingId)).toEqual(['printing-b-en']);
    const untouched = await catalog.resolve([
      { kind: 'card', cardId: 'oracle-bolt' },
      { kind: 'card', cardId: 'oracle-interrupted' },
      { kind: 'printing', printingId: 'printing-c-en' },
    ]);
    expect(untouched.revision).toEqual(first);
    expect(untouched.cards.get('oracle-bolt')?.rulesText).toBe(
      'Lightning Bolt deals 3 damage to any target.',
    );
    expect(untouched.missing).toEqual([
      { kind: 'card', cardId: 'oracle-interrupted' },
      { kind: 'printing', printingId: 'printing-c-en' },
    ]);

    const retried = await createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({
        cards: {
          sourceVersion: 'snapshot-2',
          records: [
            { ...boltEnglish, oracle_text: 'Rewritten rules text.' },
            cardRecord({
              printingId: 'printing-c-en',
              cardId: 'oracle-interrupted',
              name: 'Interrupted Card',
            }),
          ],
        },
      }),
    }).synchronize({ dataset: 'cards' });
    expect(retried.sourceVersion).toBe('snapshot-2');
    const counts = await database.query(
      `select (select count(*)::int from catalog.cards) as cards,
              (select count(*)::int from catalog.card_names) as names,
              (select count(*)::int from catalog.printings) as printings`,
    );
    expect(counts[0]).toEqual({ cards: 2, names: 2, printings: 3 });
    const volume = await catalog.resolve([{ kind: 'card', cardId: 'oracle-bolt' }]);
    expect(volume.cards.get('oracle-bolt')?.rulesText).toBe('Rewritten rules text.');
  });
});

/** Fails the transaction on the given statement so a partially written candidate is rolled back. */
function failAfterStatements(sql: CatalogSqlTransactor, failed: number): CatalogSqlTransactor {
  let calls = 0;
  return {
    query: (statement, parameters) => sql.query(statement, parameters),
    transaction: (work) =>
      sql.transaction(async (statements) =>
        work({
          async query(statement, parameters) {
            calls += 1;
            if (calls === failed) {
              throw new Error('The database connection was interrupted.');
            }
            return statements.query(statement, parameters);
          },
        }),
      ),
  };
}
