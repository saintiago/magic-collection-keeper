/**
 * Component scope: one publication is atomic for a reader on another connection
 * (docs/catalog.md#synchronization, docs/catalog.md#query-surface). PGlite serves one connection,
 * so this interleaving runs against a real PostgreSQL server: a publication pauses after every
 * statement and before its commit while a reader reads the published snapshot and change stream,
 * and the reader then resumes from the position it read without a gap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  catalogSchemaSql,
  createCatalogPublication,
  createCatalogSynchronizer,
  type CatalogPublication,
  type CatalogSnapshotSource,
} from '../../../src/catalog/index.js';
import {
  startPostgresServer,
  type PostgresConnection,
  type PostgresServer,
} from '../../support/postgres-server.js';

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
const solRing = cardRecord({
  printingId: 'printing-ring-en',
  cardId: 'oracle-sol-ring',
  name: 'Sol Ring',
  collectorNumber: '2',
});

describe('catalog publication coherence', () => {
  let server: PostgresServer | undefined;
  let writer: PostgresConnection | undefined;
  let reader: PostgresConnection | undefined;
  let unavailable = '';
  let current = { sourceVersion: 'snapshot-1', records: [bolt] as readonly unknown[] };
  const source: CatalogSnapshotSource = {
    async open() {
      const opened = current;
      return {
        sourceName: 'scryfall',
        sourceVersion: opened.sourceVersion,
        text: (async function* () {
          yield `${opened.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
        })(),
      };
    },
  };

  beforeAll(async () => {
    try {
      server = await startPostgresServer(catalogSchemaSql);
    } catch (cause) {
      unavailable = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    writer = await server.connect();
    reader = await server.connect();
  }, 120_000);

  afterAll(async () => {
    await writer?.close();
    await reader?.close();
    await server?.close();
  }, 120_000);

  it('keeps the complete previous revision readable until the publication commits', async (context) => {
    if (unavailable !== '') {
      context.skip(`A real PostgreSQL server is unavailable: ${unavailable}`);
      return;
    }
    if (writer === undefined || reader === undefined) {
      throw new Error('The coherence fixture has no connections.');
    }
    const publication: CatalogPublication = createCatalogPublication({
      sql: reader.transactor(),
    });
    const first = await createCatalogSynchronizer({
      sql: writer.transactor(),
      snapshots: source,
    }).synchronize({ dataset: 'cards' });
    const before = await publication.readSnapshot({ pageSize: 10 });
    expect(before.revision).toEqual(first);
    expect(before.records).toHaveLength(3);

    let reached: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    current = { sourceVersion: 'snapshot-2', records: [bolt, solRing] };
    const committing = createCatalogSynchronizer({
      sql: writer.transactor({
        beforeCommit: async () => {
          reached();
          await released;
        },
      }),
      snapshots: source,
    }).synchronize({ dataset: 'cards' });
    await within(paused, 'The publication never reached its commit.');

    // Every statement of the candidate ran, and none of it is visible: the reader sees the
    // complete previous revision, its position and its (empty) tail of changes.
    const streamed = await reader.query(
      'select count(*)::int as rows from catalog_private.publication',
    );
    expect(streamed[0]?.rows).toBe(4);
    const during = await publication.readSnapshot({ pageSize: 10 });
    expect(during).toEqual(before);
    const unchanged = await publication.readChanges({
      position: before.position,
      pageSize: 100,
    });
    expect(unchanged.changes).toEqual([]);

    release();
    const second = await committing;
    const after = await publication.readSnapshot({ pageSize: 10 });
    expect(after.revision).toEqual(second);
    expect(BigInt(after.position)).toBeGreaterThan(BigInt(before.position));
    expect(after.records).toHaveLength(6);

    // The position the middle read saw resumes through the committed revision without a gap.
    const resumed = await publication.readChanges({ position: before.position, pageSize: 100 });
    expect(resumed.changes.map((change) => change.kind).sort()).toEqual([
      'card',
      'card-name',
      'printing',
      'revision',
    ]);
    const advanced = await publication.readChanges({ position: resumed.position, pageSize: 100 });
    expect(advanced.changes).toEqual([]);
  });
});

/** Fails a case whose fixture never reached the point it observes. */
async function within(reached: Promise<void>, message: string): Promise<void> {
  const expired = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), 10_000).unref();
  });
  await Promise.race([reached, expired]);
}
