/**
 * Integration scope: catalog publication against real PostgreSQL semantics and grants. A
 * replacement storage runs the same cases against its own provisioned database: one publication
 * appends the changes of its records and the revision that completes them, retrying an already
 * published snapshot appends nothing, a trusted indexing role reads the publication contract and
 * cannot mutate the catalog or read other private tables, an end-user read role cannot read the
 * private stream, and removal meaning reaches a consumer as an explicit change with a stable
 * identity and no record.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  catalogPublicationGrants,
  catalogReaderGrants,
  createCatalogPublication,
  createCatalogSynchronizer,
  type CatalogPublication,
} from '../../src/catalog/index.js';
import {
  createCatalogTestDatabase,
  type CatalogTestDatabase,
} from '../support/catalog-database.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';

function cardRecord(options: {
  readonly printingId: string;
  readonly cardId: string;
  readonly name: string;
  readonly collectorNumber: string;
  readonly lang?: string;
  readonly printedName?: string;
}): Record<string, unknown> {
  return {
    object: 'card',
    id: options.printingId,
    oracle_id: options.cardId,
    name: options.name,
    lang: options.lang ?? 'en',
    set: 'tst',
    collector_number: options.collectorNumber,
    finishes: ['nonfoil'],
    nonfoil: true,
    foil: false,
    digital: false,
    oracle_text: 'Rules text.',
    type_line: 'Instant',
    colors: ['R'],
    color_identity: ['R'],
    cmc: 1,
    ...(options.printedName === undefined ? {} : { printed_name: options.printedName }),
  };
}

const bolt = cardRecord({
  printingId: 'printing-bolt-en',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  collectorNumber: '1',
});
const boltSpanish = cardRecord({
  printingId: 'printing-bolt-es',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  lang: 'es',
  printedName: 'Relámpago',
  collectorNumber: '2',
});

describe('catalog publication stream', () => {
  let database: CatalogTestDatabase;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  function publication(): CatalogPublication {
    return createCatalogPublication({ sql: database.sql });
  }

  function synchronizer(records: readonly unknown[], sourceVersion: string) {
    return createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({ cards: { sourceVersion, records } }),
    });
  }

  async function stream(): Promise<readonly Record<string, unknown>[]> {
    return await database.query(
      `select kind, record_identity from catalog_private.publication
        order by position`,
    );
  }

  it('records one durable revision and the changes of its records per publication', async () => {
    await synchronizer([bolt, boltSpanish], 'snapshot-1').synchronize({ dataset: 'cards' });

    const published = await stream();
    expect(published.map((row) => row.kind).sort()).toEqual([
      'card',
      'card-name',
      'card-name',
      'printing',
      'printing',
      'revision',
    ]);
    expect(published.at(-1)?.kind).toBe('revision');
    expect(new Set(published.map((row) => row.record_identity))).toEqual(
      new Set([
        'oracle-bolt',
        '["oracle-bolt", "en", "Lightning Bolt"]',
        '["oracle-bolt", "es", "Relámpago"]',
        'printing-bolt-en',
        'printing-bolt-es',
        null,
      ]),
    );

    // Repeating the published provider version appends nothing: the stream stays exactly as
    // complete as the revision it describes.
    const again = await synchronizer([bolt, boltSpanish], 'snapshot-1').synchronize({
      dataset: 'cards',
    });
    expect(await stream()).toEqual(published);

    const revision = await publication().readSnapshot({ pageSize: 1 });
    expect(revision.revision.revisionId).toBe(again.revisionId);
    // The revision row is the last position of the publication, and the snapshot resumes from
    // exactly that position.
    const markers = await database.query(
      `select position::text as position from catalog_private.publication where kind = 'revision'`,
    );
    expect(revision.position).toBe(markers[0]?.position);
  });

  it('grants trusted publication reads without granting mutation or private records', async () => {
    await database.exec('create role keeper_indexer');
    await database.exec('create role keeper_reader');
    await database.exec(catalogPublicationGrants('keeper_indexer'));
    await database.exec(catalogReaderGrants('keeper_reader'));
    expect(() => catalogPublicationGrants('indexer"; drop schema catalog; --')).toThrow(TypeError);

    await synchronizer([bolt], 'snapshot-1').synchronize({ dataset: 'cards' });

    await database.exec('set role keeper_indexer');
    try {
      const snapshot = await publication().readSnapshot({ pageSize: 10 });
      expect(snapshot.records.map((record) => record.kind)).toEqual([
        'card',
        'card-name',
        'printing',
      ]);
      const changes = await publication().readChanges({
        position: snapshot.position,
        pageSize: 10,
      });
      expect(changes.changes).toEqual([]);

      await expect(
        database.query(
          `insert into catalog_private.publication
             (revision_id, source_name, source_version, published_at, kind, record_identity,
              removed, record)
           values ('injected', 'scryfall', 'v', now(), 'card', 'oracle-injected', false, '{}')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(database.query('select card_id from catalog_private.card')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        database.query('select revision_id from catalog_private.revision'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }

    await database.exec('set role keeper_reader');
    try {
      await database.query('select card_id from catalog.cards');
      await expect(
        database.query('select position from catalog_private.publication'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await database.exec('reset role');
    }
  });

  it('delivers a published removal with its stable identity and no record', async () => {
    await synchronizer([bolt, boltSpanish], 'snapshot-1').synchronize({ dataset: 'cards' });
    const before = await publication().readSnapshot({ pageSize: 10 });

    const revision = await synchronizer([bolt], 'snapshot-2').synchronize({ dataset: 'cards' });

    const page = await publication().readChanges({ position: before.position, pageSize: 10 });
    const removal = page.changes.find((change) => change.kind === 'printing' && change.removed);
    expect(removal).toMatchObject({
      kind: 'printing',
      revisionId: revision.revisionId,
      reference: { kind: 'printing', printingId: 'printing-bolt-es' },
      removed: true,
      record: null,
    });
    expect(removal?.position).toMatch(/^[1-9][0-9]*$/);
  });

  it('reads a large change page in position order with the completion marker last', async () => {
    // A page whose sort does not fit its memory keeps position order: the selection takes the
    // lowest positions first, the result carries them in that order, and the revision change that
    // completes a revision stays after every record change it completes. Every position below has
    // the same digit length, so ordering the text the transport carries coincides with the numeric
    // order and only the result's own ordering can scramble the page.
    await database.exec("set work_mem = '64kB'");
    await database.exec(
      'alter table catalog_private.publication alter column position restart with 101',
    );
    await database.query(
      `insert into catalog_private.publication
         (revision_id, source_name, source_version, published_at, kind, record_identity,
          removed, record)
       select 'revision-bulk', 'scryfall', 'snapshot-1', now(), 'card',
              'oracle-bulk-' || series, false,
              jsonb_build_object(
                'card_id', 'oracle-bulk-' || series,
                'name', 'Bulk card ' || series,
                'rules_text', repeat('Bulk card rules text. ', 40),
                'type_line', 'Instant',
                'colors', jsonb_build_array('R'),
                'color_identity', jsonb_build_array('R'),
                'mana_value', 1)
       from generate_series(1, 600) as series`,
    );
    await database.query(
      `insert into catalog_private.publication
         (revision_id, source_name, source_version, published_at, kind, record_identity,
          removed, record)
       values ('revision-bulk', 'scryfall', 'snapshot-1', now(), 'revision', null, false, null)`,
    );

    // One page carries the whole stream: positions 102 to 701 in order, the last completing the
    // revision.
    const page = await publication().readChanges({ position: '101', pageSize: 1000 });
    const expected = Array.from({ length: 600 }, (_, index) => String(index + 102));
    expect(page.changes.map((change) => change.position)).toEqual(expected);
    expect(page.changes.at(-1)?.kind).toBe('revision');
    expect(page.position).toBe(expected.at(-1));

    // Paging the same stream keeps the order and reaches the same completion marker.
    const paged: string[] = [];
    let checkpoint = '101';
    for (;;) {
      const next = await publication().readChanges({ position: checkpoint, pageSize: 250 });
      if (next.changes.length === 0) {
        break;
      }
      paged.push(...next.changes.map((change) => change.position));
      checkpoint = next.position;
    }
    expect(paged).toEqual(expected);
  });
});
