/**
 * Component scope: catalog synchronization through its public contract (docs/catalog.md#synchronization).
 * A configured source supplies small deterministic provider snapshots; the cases below publish them
 * through real PostgreSQL semantics and read the result through the public read contract. They fail
 * whenever a failed or interrupted ingestion disturbs the published revision, a retry duplicates
 * identities, a record the provider dropped stops resolving, or a write statement leaves the
 * declared provider limits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATALOG_SYNCHRONIZATION_LIMITS,
  createCatalog,
  createCatalogSynchronizer,
  type Catalog,
  type CatalogRevision,
  type CatalogSnapshotSource,
  type CatalogSqlExecutor,
  type CatalogSqlTransactor,
  type CatalogSynchronizer,
} from '../../../src/catalog/index.js';
import {
  captureCatalogError,
  createCatalogTestDatabase,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';
import { createSnapshotSource } from '../../support/catalog-snapshot.js';

const lightningBolt = {
  object: 'card',
  id: 'printing-tle-32-en',
  oracle_id: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  lang: 'en',
  set: 'tle',
  collector_number: '32',
  finishes: ['nonfoil', 'foil'],
  nonfoil: true,
  foil: true,
  etched: false,
  digital: false,
  oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  type_line: 'Instant',
  colors: ['R', 'R'],
  color_identity: ['R'],
  cmc: 1,
  image_uris: {
    small: 'https://images.example.test/tle-32-small.jpg',
    normal: 'https://images.example.test/tle-32-normal.jpg',
    large: 'https://images.example.test/tle-32-large.jpg',
    art_crop: 'https://images.example.test/tle-32-art.jpg',
  },
};

const lightningBoltSpanish = {
  ...lightningBolt,
  id: 'printing-tle-32-es',
  printed_name: 'Relámpago',
  lang: 'es',
};

const delverOfSecrets = {
  object: 'card',
  id: 'printing-mid-47-en',
  oracle_id: 'oracle-delver-of-secrets',
  name: 'Delver of Secrets // Insectile Aberration',
  lang: 'en',
  set: 'mid',
  collector_number: '47',
  finishes: ['nonfoil'],
  nonfoil: true,
  foil: false,
  digital: false,
  type_line: 'Creature — Human Wizard // Creature — Human Insect',
  color_identity: ['U'],
  cmc: 1,
  card_faces: [
    {
      object: 'card_face',
      name: 'Delver of Secrets',
      oracle_text: 'At the beginning of your upkeep, look at the top card of your library.',
      colors: ['U'],
      image_uris: {
        small: 'https://images.example.test/mid-47-front-small.jpg',
        art_crop: 'https://images.example.test/mid-47-front-art.jpg',
      },
    },
    {
      object: 'card_face',
      name: 'Insectile Aberration',
      oracle_text: 'Flying',
      colors: ['U'],
      image_uris: { normal: 'https://images.example.test/mid-47-back-normal.jpg' },
    },
  ],
};

const digitalOnlyCard = {
  object: 'card',
  id: 'printing-mtgo-1-en',
  oracle_id: 'oracle-digital-only',
  name: 'Digital Only',
  lang: 'en',
  set: 'mtgo',
  collector_number: '1',
  finishes: ['nonfoil'],
  nonfoil: true,
  foil: false,
  digital: true,
  oracle_text: '',
  type_line: 'Creature — Elemental',
  colors: [],
  color_identity: [],
  cmc: 0,
};

function generatedRecord(index: number): unknown {
  return {
    object: 'card',
    id: `printing-generated-${index}`,
    oracle_id: `oracle-generated-${index}`,
    name: `Generated Card ${index}`,
    lang: 'en',
    set: 'gen',
    collector_number: String(index),
    finishes: ['nonfoil'],
    nonfoil: true,
    foil: false,
    digital: false,
    oracle_text: `Generated rules text for card ${index}. `.repeat(40),
    type_line: 'Creature — Test',
    colors: ['G'],
    color_identity: ['G'],
    cmc: 2,
    image_uris: { small: `https://images.example.test/generated-${index}-small.jpg` },
  };
}

describe('catalog synchronization', () => {
  let database: CatalogTestDatabase;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  function synchronizer(
    snapshots: CatalogSnapshotSource,
    sql: CatalogSqlTransactor = database.sql,
  ): CatalogSynchronizer {
    return createCatalogSynchronizer({ sql, snapshots });
  }

  function catalog(): Catalog {
    return createCatalog({ sql: database.sql });
  }

  async function publishedRevision(): Promise<CatalogRevision> {
    const revision = await catalog().resolve([]);
    return revision.revision;
  }

  it('publishes one snapshot as a revision that reads resolve', async () => {
    const snapshots = createSnapshotSource({
      all_cards: {
        sourceVersion: '2026-09-26T21:01:58.161Z',
        records: [lightningBolt, lightningBoltSpanish, delverOfSecrets, digitalOnlyCard],
      },
    });

    const revision = await synchronizer(snapshots).synchronize({ dataset: 'all_cards' });

    expect(revision.sourceName).toBe('scryfall');
    expect(revision.sourceVersion).toBe('2026-09-26T21:01:58.161Z');
    expect(revision.revisionId).not.toBe('');
    expect(Number.isNaN(Date.parse(revision.publishedAt))).toBe(false);

    const resolution = await catalog().resolve([
      { kind: 'card', cardId: 'oracle-lightning-bolt' },
      { kind: 'card', cardId: 'oracle-delver-of-secrets' },
      { kind: 'printing', printingId: 'printing-tle-32-es' },
      { kind: 'printing', printingId: 'printing-mid-47-en' },
      { kind: 'printing', printingId: 'printing-mtgo-1-en' },
    ]);
    expect(resolution.revision).toEqual(revision);
    expect(resolution.missing).toEqual([]);

    const bolt = resolution.cards.get('oracle-lightning-bolt');
    expect(bolt?.name).toBe('Lightning Bolt');
    expect(bolt?.names).toEqual([
      { language: 'en', name: 'Lightning Bolt' },
      { language: 'es', name: 'Relámpago' },
    ]);
    expect(bolt?.colors).toEqual(['R']);

    expect(resolution.printings.get('printing-tle-32-es')).toEqual({
      printingId: 'printing-tle-32-es',
      cardId: 'oracle-lightning-bolt',
      edition: 'tle',
      collectorNumber: '32',
      language: 'es',
      finishes: ['nonfoil', 'foil'],
      physical: true,
      images: {
        small: 'https://images.example.test/tle-32-small.jpg',
        normal: 'https://images.example.test/tle-32-normal.jpg',
        large: 'https://images.example.test/tle-32-large.jpg',
        artCrop: 'https://images.example.test/tle-32-art.jpg',
      },
    });
    expect(resolution.printings.get('printing-mtgo-1-en')?.physical).toBe(false);

    const delver = resolution.cards.get('oracle-delver-of-secrets');
    // The public read contract orders name rows; the snapshot's own record order is not published.
    expect(delver?.names.map((name) => name.name)).toEqual([
      'Delver of Secrets',
      'Delver of Secrets // Insectile Aberration',
      'Insectile Aberration',
    ]);
    expect(delver?.rulesText).toBe(
      'At the beginning of your upkeep, look at the top card of your library.\n//\nFlying',
    );
    expect(delver?.typeLine).toBe('Creature — Human Wizard // Creature — Human Insect');
    expect(delver?.colors).toEqual(['U']);
    expect(resolution.printings.get('printing-mid-47-en')?.images).toEqual({
      small: 'https://images.example.test/mid-47-front-small.jpg',
      normal: null,
      large: null,
      artCrop: 'https://images.example.test/mid-47-front-art.jpg',
    });
  });

  it('republishes changed records and keeps identities the provider stopped publishing', async () => {
    await synchronizer(
      createSnapshotSource({
        cards: { sourceVersion: 'snapshot-1', records: [lightningBolt, delverOfSecrets] },
      }),
    ).synchronize({ dataset: 'cards' });
    const revision = await synchronizer(
      createSnapshotSource({
        cards: {
          sourceVersion: 'snapshot-2',
          records: [
            { ...lightningBolt, oracle_text: 'Lightning Bolt deals 3 damage to any target.' },
            digitalOnlyCard,
          ],
        },
      }),
    ).synchronize({ dataset: 'cards' });

    const resolution = await catalog().resolve([
      { kind: 'card', cardId: 'oracle-delver-of-secrets' },
      { kind: 'printing', printingId: 'printing-mid-47-en' },
      { kind: 'card', cardId: 'oracle-digital-only' },
    ]);
    expect(resolution.revision).toEqual(revision);
    expect(resolution.missing).toEqual([]);
    expect(resolution.printings.get('printing-mid-47-en')?.cardId).toBe('oracle-delver-of-secrets');

    const counts = await database.query(
      `select (select count(*)::int from catalog.cards) as cards,
              (select count(*)::int from catalog.card_names) as names,
              (select count(*)::int from catalog.printings) as printings`,
    );
    expect(counts[0]).toEqual({ cards: 3, names: 5, printings: 3 });
  });

  it('leaves out provider records that publish no card identity', async () => {
    // Scryfall publishes reversible promo cards without an oracle identity; they have no playable
    // identity to own, and they must not fail an otherwise readable snapshot.
    const reversiblePromo = {
      object: 'card',
      id: 'printing-slp-1-en',
      name: 'Ghalta, Primal Hunger // Ghalta, Primal Hunger',
      lang: 'en',
      set: 'slp',
      collector_number: '1',
      finishes: ['nonfoil'],
      nonfoil: true,
      digital: false,
      type_line: 'Legendary Creature — Dinosaur // Legendary Creature — Dinosaur',
      color_identity: ['G'],
      card_faces: [{ object: 'card_face', name: 'Ghalta, Primal Hunger', colors: ['G'] }],
    };

    const revision = await synchronizer(
      createSnapshotSource({
        cards: { sourceVersion: 'snapshot-1', records: [lightningBolt, reversiblePromo] },
      }),
    ).synchronize({ dataset: 'cards' });

    const resolution = await catalog().resolve([
      { kind: 'printing', printingId: 'printing-tle-32-en' },
      { kind: 'printing', printingId: 'printing-slp-1-en' },
    ]);
    expect(resolution.revision).toEqual(revision);
    expect(resolution.printings.has('printing-tle-32-en')).toBe(true);
    expect(resolution.missing).toEqual([{ kind: 'printing', printingId: 'printing-slp-1-en' }]);

    const identityLessOnly = await captureCatalogError(
      synchronizer(
        createSnapshotSource({
          cards: { sourceVersion: 'snapshot-2', records: [reversiblePromo] },
        }),
      ).synchronize({ dataset: 'cards' }),
    );
    expect(identityLessOnly.code).toBe('unavailable');
    expect(await publishedRevision()).toEqual(revision);
  });

  it('keeps the published revision when the requested snapshot is malformed', async () => {
    const first = await synchronizer(
      createSnapshotSource({ cards: { sourceVersion: 'snapshot-1', records: [lightningBolt] } }),
    ).synchronize({ dataset: 'cards' });

    const unreadable: readonly SnapshotFailure[] = [
      { name: 'truncated JSON', text: '{"object": "card",\n' },
      { name: 'empty snapshot', records: [] },
      {
        name: 'record that is not a card',
        records: [lightningBolt, { object: 'card', id: 'printing-broken' }],
      },
      {
        name: 'printing without a supported finish',
        records: [{ ...digitalOnlyCard, finishes: ['surge'], nonfoil: false }],
      },
      {
        name: 'record beyond the declared write bound',
        records: [
          {
            ...lightningBolt,
            oracle_text: 'x'.repeat(CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes + 1),
          },
        ],
      },
    ];

    for (const failure of unreadable) {
      const snapshots = createSnapshotSource({
        cards: {
          sourceVersion: 'snapshot-2',
          records: failure.records,
          text: failure.text,
        },
      });
      const error = await captureCatalogError(
        synchronizer(snapshots).synchronize({ dataset: 'cards' }),
      );
      expect(error.code, failure.name).toBe('unavailable');
      expect(await publishedRevision(), failure.name).toEqual(first);
    }

    const recovered = await synchronizer(
      createSnapshotSource({
        cards: { sourceVersion: 'snapshot-2', records: [lightningBolt, digitalOnlyCard] },
      }),
    ).synchronize({ dataset: 'cards' });
    expect(recovered.revisionId).not.toBe(first.revisionId);
    expect(recovered.sourceVersion).toBe('snapshot-2');
    const rows = await database.query('select count(*)::int as cards from catalog.cards');
    expect(rows[0]).toEqual({ cards: 2 });
  });

  it('rolls back an ingestion interrupted after part of the candidate was written', async () => {
    const first = await synchronizer(
      createSnapshotSource({ cards: { sourceVersion: 'snapshot-1', records: [lightningBolt] } }),
    ).synchronize({ dataset: 'cards' });

    const records = Array.from({ length: 300 }, (_, index) => generatedRecord(index));
    const interrupted = failAfterStatements(database.sql, 4);
    const error = await captureCatalogError(
      synchronizer(
        createSnapshotSource({ cards: { sourceVersion: 'snapshot-2', records } }),
        interrupted,
      ).synchronize({ dataset: 'cards' }),
    );

    expect(error.code).toBe('unavailable');
    expect(await publishedRevision()).toEqual(first);
    const rows = await database.query(
      `select (select count(*)::int from catalog.cards) as cards,
              (select count(*)::int from catalog.printings) as printings`,
    );
    expect(rows[0]).toEqual({ cards: 1, printings: 1 });

    const recovered = await synchronizer(
      createSnapshotSource({ cards: { sourceVersion: 'snapshot-2', records } }),
    ).synchronize({ dataset: 'cards' });
    expect(recovered.sourceVersion).toBe('snapshot-2');
    const retried = await database.query('select count(*)::int as cards from catalog.cards');
    expect(retried[0]).toEqual({ cards: 301 });
  });

  it('keeps published reads working when the source transfer fails mid-snapshot', async () => {
    const first = await synchronizer(
      createSnapshotSource({ cards: { sourceVersion: 'snapshot-1', records: [lightningBolt] } }),
    ).synchronize({ dataset: 'cards' });

    const interrupted: CatalogSnapshotSource = {
      async open() {
        return {
          sourceName: 'scryfall',
          sourceVersion: 'snapshot-2',
          text: (async function* () {
            yield `${JSON.stringify({ ...lightningBolt, printed_name: 'Ray' })}\n`;
            throw new Error('The snapshot transfer was interrupted.');
          })(),
        };
      },
    };
    const error = await captureCatalogError(
      synchronizer(interrupted).synchronize({ dataset: 'cards' }),
    );

    expect(error.code).toBe('unavailable');
    const resolution = await catalog().resolve([
      { kind: 'card', cardId: 'oracle-lightning-bolt' },
      { kind: 'printing', printingId: 'printing-tle-32-en' },
    ]);
    expect(resolution.revision).toEqual(first);
    expect(resolution.missing).toEqual([]);
    expect(resolution.cards.get('oracle-lightning-bolt')?.names).toEqual([
      { language: 'en', name: 'Lightning Bolt' },
    ]);
  });

  it('does not ingest a snapshot whose version is already published', async () => {
    const source = countingSource('snapshot-1', [lightningBolt]);
    const synchronization = synchronizer(source.source);

    const first = await synchronization.synchronize({ dataset: 'cards' });
    expect(source.read).toBe(1);

    const second = await synchronization.synchronize({ dataset: 'cards' });
    expect(second).toEqual(first);
    expect(source.opened).toBe(2);
    expect(source.read).toBe(1);
  });

  it('reports a held publication lock as busy without writing anything', async () => {
    const refused = lockRefusingTransactor();
    const error = await captureCatalogError(
      synchronizer(
        createSnapshotSource({ cards: { sourceVersion: 'v', records: [lightningBolt] } }),
        refused,
      ).synchronize({ dataset: 'cards' }),
    );

    expect(error.code).toBe('busy');
    expect(refused.statements).toEqual([]);
  });

  it('rejects a request that names no dataset and reports source failures', async () => {
    const requestError = await captureCatalogError(
      synchronizer(createSnapshotSource({})).synchronize({ dataset: '' }),
    );
    expect(requestError.code).toBe('invalid-request');

    const sourceError = await captureCatalogError(
      synchronizer(createSnapshotSource({})).synchronize({ dataset: 'not-configured' }),
    );
    expect(sourceError.code).toBe('unavailable');
  });

  it('keeps every write statement inside the declared transport bounds', async () => {
    const records = Array.from({ length: 250 }, (_, index) => generatedRecord(index));
    const written = recordStatementSizes(database.sql);

    await synchronizer(
      createSnapshotSource({ cards: { sourceVersion: 'snapshot-1', records } }),
      written.sql,
    ).synchronize({ dataset: 'cards' });

    const batches = written.batches.filter((batch) => batch.kind === 'card');
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of written.batches) {
      expect(batch.bytes).toBeLessThanOrEqual(CATALOG_SYNCHRONIZATION_LIMITS.maxStatementBytes);
    }
    for (const batch of batches) {
      expect(batch.records).toBeLessThanOrEqual(
        CATALOG_SYNCHRONIZATION_LIMITS.maxRecordsPerStatement,
      );
    }
  });
});

interface SnapshotFailure {
  readonly name: string;
  readonly records?: readonly unknown[];
  readonly text?: string;
}

/** Counts how often a source is opened and how often its snapshot text is actually read. */
function countingSource(
  sourceVersion: string,
  records: readonly unknown[],
): {
  readonly source: CatalogSnapshotSource;
  opened: number;
  read: number;
} {
  const counter = {
    opened: 0,
    read: 0,
    source: {
      async open() {
        counter.opened += 1;
        return {
          sourceName: 'scryfall',
          sourceVersion,
          text: (async function* () {
            counter.read += 1;
            yield `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
          })(),
        };
      },
    },
  };
  return counter;
}

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

/** An executor whose publication lock is already held by another task. */
function lockRefusingTransactor(): CatalogSqlTransactor & { readonly statements: string[] } {
  const statements: string[] = [];
  const executor: CatalogSqlExecutor = {
    async query(statement) {
      if (statement.includes('pg_try_advisory_xact_lock')) {
        return [{ locked: 'false' }];
      }
      if (statement.includes('catalog.published_revision')) {
        return [];
      }
      statements.push(statement);
      return [];
    },
  };
  return {
    query: (statement, parameters) => executor.query(statement, parameters),
    transaction: (work) => work(executor),
    statements,
  };
}

/** Records the size and record count of each batched write statement. */
function recordStatementSizes(sql: CatalogSqlTransactor): {
  readonly sql: CatalogSqlTransactor;
  readonly batches: readonly {
    readonly kind: string;
    readonly bytes: number;
    readonly records: number;
  }[];
} {
  const batches: { kind: string; bytes: number; records: number }[] = [];
  const kindOf = (statement: string): string | null => {
    if (statement.includes('catalog_private.card (') && !statement.includes('card_name')) {
      return 'card';
    }
    if (statement.includes('catalog_private.card_name')) {
      return 'name';
    }
    if (statement.includes('catalog_private.printing (')) {
      return 'printing';
    }
    return null;
  };
  return {
    batches,
    sql: {
      query: (statement, parameters) => sql.query(statement, parameters),
      transaction: (work) =>
        sql.transaction((statements) =>
          work({
            async query(statement, parameters = {}) {
              const kind = kindOf(statement);
              const batch = kind === null ? undefined : Object.values(parameters)[0];
              if (kind !== null && typeof batch === 'string') {
                batches.push({
                  kind,
                  bytes: Buffer.byteLength(batch, 'utf8'),
                  records: (JSON.parse(batch) as unknown[]).length,
                });
              }
              return statements.query(statement, parameters);
            },
          }),
        ),
    },
  };
}
