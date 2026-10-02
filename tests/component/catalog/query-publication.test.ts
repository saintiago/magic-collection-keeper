/**
 * Component scope: the catalog query publication through its public contract
 * (docs/catalog.md#query-surface). A configured provider source publishes small deterministic
 * snapshots; the cases read the snapshot and the change stream a consumer sees. They fail whenever
 * a snapshot mixes revisions or loses records, the change stream skips, repeats or silently drops
 * a published change, an interrupted publication disturbs what consumers can read, or a position
 * the catalog can no longer serve is reported as an empty result instead of requiring a new
 * snapshot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CATALOG_PUBLICATION_LIMITS,
  createCatalog,
  createCatalogPublication,
  createCatalogSynchronizer,
  type Catalog,
  type CatalogChange,
  type CatalogPublication,
  type CatalogPublishedRecord,
  type CatalogRevision,
  type CatalogSnapshotSource,
  type CatalogSqlTransactor,
} from '../../../src/catalog/index.js';
import {
  captureCatalogError,
  createCatalogTestDatabase,
  type CatalogTestDatabase,
} from '../../support/catalog-database.js';

function providerCard(options: {
  readonly printingId: string;
  readonly cardId: string;
  readonly name: string;
  readonly collectorNumber: string;
  readonly lang?: string;
  readonly printedName?: string;
  readonly oracleText?: string;
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
    oracle_text: options.oracleText ?? 'Rules text.',
    type_line: 'Instant',
    colors: ['R'],
    color_identity: ['R'],
    cmc: 1,
    ...(options.printedName === undefined ? {} : { printed_name: options.printedName }),
  };
}

const bolt = providerCard({
  printingId: 'printing-bolt-en',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  collectorNumber: '1',
  oracleText: 'Lightning Bolt deals 3 damage to any target.',
});
const boltSpanish = providerCard({
  printingId: 'printing-bolt-es',
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  lang: 'es',
  printedName: 'Relámpago',
  collectorNumber: '2',
  oracleText: 'Lightning Bolt deals 3 damage to any target.',
});
const solRing = providerCard({
  printingId: 'printing-ring-en',
  cardId: 'oracle-sol-ring',
  name: 'Sol Ring',
  collectorNumber: '3',
  oracleText: '{T}: Add {C}{C}.',
});
const counterspell = providerCard({
  printingId: 'printing-counterspell-en',
  cardId: 'oracle-counterspell',
  name: 'Counterspell',
  collectorNumber: '4',
  oracleText: 'Counter target spell.',
});
const darkRitual = providerCard({
  printingId: 'printing-dark-ritual-en',
  cardId: 'oracle-dark-ritual',
  name: 'Dark Ritual',
  collectorNumber: '5',
  oracleText: 'Add {B}{B}{B}.',
});

const finishlessDigital = {
  ...providerCard({
    printingId: '4c2abf39-90f5-46c2-b52c-49f2f43fce22',
    cardId: 'oracle-digital-only',
    name: 'Digital Only',
    collectorNumber: '6',
  }),
  id: '4c2abf39-90f5-46c2-b52c-49f2f43fce22',
  oracle_id: 'oracle-digital-only',
  finishes: [],
  nonfoil: true,
  digital: true,
};

/** A provider source whose next snapshot one test names, so revisions follow each other. */
function providerSource(): {
  readonly source: CatalogSnapshotSource;
  snapshot(sourceVersion: string, records: readonly unknown[]): void;
} {
  let current = { sourceVersion: 'snapshot-0', records: [] as readonly unknown[] };
  return {
    source: {
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
    },
    snapshot(sourceVersion, records) {
      current = { sourceVersion, records };
    },
  };
}

function summarize(record: CatalogPublishedRecord): string {
  switch (record.kind) {
    case 'card':
      return `card:${record.card.cardId}:${record.card.name}:${record.card.rulesText ?? ''}`;
    case 'card-name':
      return `name:${record.name.cardId}:${record.name.language}:${record.name.name}`;
    case 'printing':
      return (
        `printing:${record.printing.printingId}:${record.printing.cardId}:` +
        `${record.printing.language}:${record.printing.finishes.join('|')}`
      );
  }
}

function summarizeChange(change: CatalogChange): string {
  if (change.kind === 'revision') {
    return `revision:${change.revision.revisionId}:${change.revision.sourceVersion}`;
  }
  const identity =
    change.reference.kind === 'card'
      ? change.reference.cardId
      : change.reference.kind === 'printing'
        ? change.reference.printingId
        : `${change.reference.cardId}/${change.reference.language}/${change.reference.name}`;
  return `${change.kind}:${change.removed ? 'removed' : 'upsert'}:${identity}`;
}

describe('catalog query publication', () => {
  let database: CatalogTestDatabase;
  let provider: ReturnType<typeof providerSource>;

  beforeEach(async () => {
    database = await createCatalogTestDatabase();
    provider = providerSource();
  });

  afterEach(async () => {
    await database.close();
  });

  function synchronizer(sql: CatalogSqlTransactor = database.sql) {
    return createCatalogSynchronizer({ sql, snapshots: provider.source });
  }

  function publication(): CatalogPublication {
    return createCatalogPublication({ sql: database.sql });
  }

  async function publish(
    sourceVersion: string,
    records: readonly unknown[],
  ): Promise<CatalogRevision> {
    provider.snapshot(sourceVersion, records);
    return await synchronizer().synchronize({ dataset: 'cards' });
  }

  /** Reads every page of one snapshot, as a consumer rebuilding its own searchable storage does. */
  async function readWholeSnapshot(
    reader: CatalogPublication,
    pageSize: number,
  ): Promise<{
    readonly revision: CatalogRevision;
    readonly position: string;
    readonly records: readonly CatalogPublishedRecord[];
  }> {
    const first = await reader.readSnapshot({ pageSize });
    const records = [...first.records];
    let continuation = first.continuation;
    while (continuation !== null) {
      const page = await reader.readSnapshot({ pageSize, continuation });
      expect(page.revision).toEqual(first.revision);
      expect(page.position).toBe(first.position);
      records.push(...page.records);
      continuation = page.continuation;
    }
    return { revision: first.revision, position: first.position, records };
  }

  it('reads a complete paginated snapshot of the one published revision', async () => {
    const published = await publish('snapshot-1', [bolt, boltSpanish, solRing]);

    const snapshot = await readWholeSnapshot(publication(), 2);

    expect(snapshot.revision).toEqual(published);
    expect(snapshot.position).toMatch(/^[1-9][0-9]*$/);
    expect(snapshot.records.map(summarize).sort()).toEqual(
      [
        'card:oracle-bolt:Lightning Bolt:Lightning Bolt deals 3 damage to any target.',
        'card:oracle-sol-ring:Sol Ring:{T}: Add {C}{C}.',
        'name:oracle-bolt:en:Lightning Bolt',
        'name:oracle-bolt:es:Relámpago',
        'name:oracle-sol-ring:en:Sol Ring',
        'printing:printing-bolt-en:oracle-bolt:en:nonfoil',
        'printing:printing-bolt-es:oracle-bolt:es:nonfoil',
        'printing:printing-ring-en:oracle-sol-ring:en:nonfoil',
      ].sort(),
    );

    // The snapshot decodes the published facts, not just their identities.
    const card = snapshot.records.find(
      (record) => record.kind === 'card' && record.card.cardId === 'oracle-bolt',
    );
    expect(card).toEqual({
      kind: 'card',
      card: {
        cardId: 'oracle-bolt',
        name: 'Lightning Bolt',
        rulesText: 'Lightning Bolt deals 3 damage to any target.',
        typeLine: 'Instant',
        colors: ['R'],
        colorIdentity: ['R'],
        manaValue: 1,
      },
    });
    const printing = snapshot.records.find(
      (record) => record.kind === 'printing' && record.printing.printingId === 'printing-bolt-es',
    );
    expect(printing).toEqual({
      kind: 'printing',
      printing: {
        printingId: 'printing-bolt-es',
        cardId: 'oracle-bolt',
        edition: 'tst',
        collectorNumber: '2',
        language: 'es',
        finishes: ['nonfoil'],
        physical: true,
        images: { small: null, normal: null, large: null, artCrop: null },
      },
    });
  });

  it('publishes a nonphysical printing with no physical finishes in snapshots and changes', async () => {
    await publish('snapshot-1', [bolt]);
    const before = await readWholeSnapshot(publication(), 100);

    const revision = await publish('snapshot-2', [bolt, finishlessDigital]);
    const snapshot = await readWholeSnapshot(publication(), 1);
    const printing = snapshot.records.find(
      (record) => record.kind === 'printing' && record.printing.printingId === finishlessDigital.id,
    );
    expect(printing).toEqual({
      kind: 'printing',
      printing: {
        printingId: finishlessDigital.id,
        cardId: finishlessDigital.oracle_id,
        edition: 'tst',
        collectorNumber: '6',
        language: 'en',
        finishes: [],
        physical: false,
        images: { small: null, normal: null, large: null, artCrop: null },
      },
    });

    const changes = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(
      changes.changes.find(
        (change) =>
          change.kind === 'printing' &&
          change.reference.kind === 'printing' &&
          change.reference.printingId === finishlessDigital.id,
      ),
    ).toMatchObject({ revisionId: revision.revisionId, record: printing });
  });

  it('publishes retained revision incorporation evidence with every snapshot page', async () => {
    const first = await publish('snapshot-1', [bolt]);
    const second = await publish('snapshot-2', [bolt, solRing]);
    const page = await publication().readSnapshot({ pageSize: 1 });
    expect(page.incorporatedRevisions).toEqual(
      expect.arrayContaining([first.revisionId, second.revisionId]),
    );
    expect(page.incorporatedRevisions.length).toBeLessThanOrEqual(
      CATALOG_PUBLICATION_LIMITS.retainedPublications,
    );
    const next = await publication().readSnapshot({
      pageSize: 1,
      continuation: page.continuation!,
    });
    expect(next.incorporatedRevisions).toEqual(page.incorporatedRevisions);
  });

  it('resumes the durable changes from the snapshot position without a gap', async () => {
    await publish('snapshot-1', [bolt]);
    const before = await readWholeSnapshot(publication(), 1);
    expect(before.records.map(summarize)).toEqual([
      'card:oracle-bolt:Lightning Bolt:Lightning Bolt deals 3 damage to any target.',
      'name:oracle-bolt:en:Lightning Bolt',
      'printing:printing-bolt-en:oracle-bolt:en:nonfoil',
    ]);

    const revised = providerCard({
      printingId: 'printing-bolt-en',
      cardId: 'oracle-bolt',
      name: 'Lightning Bolt',
      collectorNumber: '1',
      oracleText: 'Lightning Bolt deals 3 damage to any target or battle.',
    });
    const published = await publish('snapshot-2', [revised, solRing]);

    const page = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(page.changes.map(summarizeChange).sort()).toEqual(
      [
        'card:upsert:oracle-bolt',
        'card:upsert:oracle-sol-ring',
        'card-name:upsert:oracle-sol-ring/en/Sol Ring',
        'printing:upsert:printing-ring-en',
        `revision:${published.revisionId}:snapshot-2`,
      ].sort(),
    );
    expect(page.changes.at(-1)?.kind).toBe('revision');
    for (const change of page.changes) {
      expect(Number(change.position)).toBeGreaterThan(Number(before.position));
      if (change.kind !== 'revision') {
        expect(change.revisionId).toBe(published.revisionId);
        expect(change.removed).toBe(false);
      }
    }
    const card = page.changes.find(
      (change) => change.kind === 'card' && change.reference.kind === 'card',
    );
    expect(card?.kind === 'card' ? card.record : null).toEqual({
      kind: 'card',
      card: {
        cardId: 'oracle-bolt',
        name: 'Lightning Bolt',
        rulesText: 'Lightning Bolt deals 3 damage to any target or battle.',
        typeLine: 'Instant',
        colors: ['R'],
        colorIdentity: ['R'],
        manaValue: 1,
      },
    });
    expect(page.position).toBe(page.changes.at(-1)?.position);

    // Reading the same position again preserves the same meaning, and the page's own position
    // delivers nothing further until another revision is published.
    const repeated = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(repeated.changes).toEqual(page.changes);
    const advanced = await publication().readChanges({ position: page.position, pageSize: 100 });
    expect(advanced.changes).toEqual([]);
    expect(advanced.position).toBe(page.position);
  });

  it('delivers every change in position order across a decimal digit boundary', async () => {
    await publish('snapshot-1', [bolt]);
    const before = await readWholeSnapshot(publication(), 100);
    expect(Number(before.position)).toBeLessThan(10);

    // Three cards publish nine record changes plus the revision that completes them, so a consumer
    // paging one change at a time crosses from one-digit to two-digit positions.
    await publish('snapshot-2', [bolt, solRing, counterspell, darkRitual]);

    const delivered: string[] = [];
    let lastKind: CatalogChange['kind'] | null = null;
    let checkpoint = before.position;
    for (;;) {
      const page = await publication().readChanges({ position: checkpoint, pageSize: 1 });
      if (page.changes.length === 0) {
        expect(page.position).toBe(checkpoint);
        break;
      }
      expect(page.changes).toHaveLength(1);
      const change = page.changes[0];
      // The page always advances to the change it delivered last, never past it.
      expect(page.position).toBe(change?.position);
      delivered.push(change?.position ?? '');
      lastKind = change?.kind ?? null;
      checkpoint = page.position;
    }

    const expected = Array.from({ length: 10 }, (_, index) =>
      String(Number(before.position) + 1 + index),
    );
    expect(delivered).toEqual(expected);
    expect(lastKind).toBe('revision');
  });

  it('completes a revision that changed no record with its revision change', async () => {
    await publish('snapshot-1', [bolt]);
    const before = await readWholeSnapshot(publication(), 100);

    const published = await publish('snapshot-2', [bolt]);

    const page = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(page.changes.map(summarizeChange)).toEqual([
      `revision:${published.revisionId}:snapshot-2`,
    ]);
    const after = await readWholeSnapshot(publication(), 100);
    expect(after.revision).toEqual(published);
    expect(after.records).toEqual(before.records);
  });

  it('keeps what consumers read when a publication is interrupted', async () => {
    await publish('snapshot-1', [bolt]);
    const before = await readWholeSnapshot(publication(), 100);

    provider.snapshot('snapshot-2', [bolt, solRing]);
    const error = await captureCatalogError(
      synchronizer(failAfterStatements(database.sql, 4)).synchronize({ dataset: 'cards' }),
    );
    expect(error.code).toBe('unavailable');

    const preserved = await readWholeSnapshot(publication(), 100);
    expect(preserved.revision).toEqual(before.revision);
    expect(preserved.position).toBe(before.position);
    expect(preserved.records).toEqual(before.records);
    const changes = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(changes.changes).toEqual([]);

    const recovered = await synchronizer().synchronize({ dataset: 'cards' });
    expect(recovered.sourceVersion).toBe('snapshot-2');
    const resumed = await readWholeSnapshot(publication(), 100);
    expect(resumed.revision).toEqual(recovered);
    expect(BigInt(resumed.position)).toBeGreaterThan(BigInt(before.position));
  });

  it('requires a new snapshot when the revision changed inside a paginated read', async () => {
    await publish('snapshot-1', [bolt, solRing]);
    const first = await publication().readSnapshot({ pageSize: 1 });
    expect(first.continuation).not.toBeNull();

    await publish('snapshot-2', [bolt, solRing, boltSpanish]);

    const stale = await captureCatalogError(
      publication().readSnapshot({ pageSize: 1, continuation: first.continuation ?? '' }),
    );
    expect(stale.code).toBe('stale-continuation');

    const restarted = await readWholeSnapshot(publication(), 1);
    expect(restarted.revision.sourceVersion).toBe('snapshot-2');
    expect(restarted.records.map(summarize)).toContain(
      'printing:printing-bolt-es:oracle-bolt:es:nonfoil',
    );
  });

  it('requires a new snapshot when a change position left the retained history', async () => {
    const positions: string[] = [];
    for (
      let revision = 1;
      revision <= CATALOG_PUBLICATION_LIMITS.retainedPublications + 1;
      revision += 1
    ) {
      await publish(`snapshot-${revision}`, [bolt]);
      positions.push((await readWholeSnapshot(publication(), 1)).position);
    }

    const expired = await captureCatalogError(
      publication().readChanges({ position: positions[0] ?? '', pageSize: 10 }),
    );
    expect(expired.code).toBe('stale-continuation');
    expect(expired.message).toContain('snapshot');

    // The retained history still serves a position that is inside the window.
    const retained = await publication().readChanges({
      position: positions[1] ?? '',
      pageSize: 100,
    });
    expect(retained.changes).toHaveLength(CATALOG_PUBLICATION_LIMITS.retainedPublications - 1);

    const restarted = await readWholeSnapshot(publication(), 1);
    const current = await publication().readChanges({ position: restarted.position, pageSize: 10 });
    expect(current.changes).toEqual([]);
  });

  it('rejects unreadable requests and reports an unpublished catalog', async () => {
    const unpublish = publication();
    expect((await captureCatalogError(unpublish.readSnapshot())).code).toBe('unavailable');
    expect((await captureCatalogError(unpublish.readChanges({ position: '1' }))).code).toBe(
      'unavailable',
    );

    await publish('snapshot-1', [bolt]);
    expect((await captureCatalogError(publication().readSnapshot({ pageSize: 0 }))).code).toBe(
      'invalid-request',
    );
    expect(
      (await captureCatalogError(publication().readSnapshot({ continuation: 'not-a-token' }))).code,
    ).toBe('invalid-request');
    expect(
      (await captureCatalogError(publication().readChanges({ position: 'the-latest' }))).code,
    ).toBe('invalid-request');
    const snapshot = await readWholeSnapshot(publication(), 1);
    const future = await captureCatalogError(
      publication().readChanges({ position: String(Number(snapshot.position) + 1) }),
    );
    expect(future.code).toBe('stale-continuation');
  });

  it('retains every published lookup while changes follow current membership', async () => {
    await publish('snapshot-1', [bolt, solRing]);
    const before = await readWholeSnapshot(publication(), 100);

    // Provider-dropped records leave current membership but stay exactly resolvable.
    const published = await publish('snapshot-2', [boltSpanish]);

    const catalog: Catalog = createCatalog({ sql: database.sql });
    const resolution = await catalog.resolve([
      { kind: 'card', cardId: 'oracle-sol-ring' },
      { kind: 'printing', printingId: 'printing-ring-en' },
    ]);
    expect(resolution.revision).toEqual(published);
    expect(resolution.missing).toEqual([]);

    const page = await publication().readChanges({ position: before.position, pageSize: 100 });
    expect(page.changes.map(summarizeChange).sort()).toEqual(
      [
        'card-name:removed:oracle-bolt/en/Lightning Bolt',
        'card-name:removed:oracle-sol-ring/en/Sol Ring',
        'card-name:upsert:oracle-bolt/es/Relámpago',
        'card:removed:oracle-sol-ring',
        'printing:removed:printing-bolt-en',
        'printing:removed:printing-ring-en',
        'printing:upsert:printing-bolt-es',
        `revision:${published.revisionId}:snapshot-2`,
      ].sort(),
    );
    expect(page.changes.some((change) => change.kind !== 'revision' && change.removed)).toBe(true);
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
