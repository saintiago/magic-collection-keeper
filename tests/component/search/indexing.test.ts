/**
 * Component scope: Search indexing through its public contract, over supplied publication
 * fixtures and Search's own real projection storage (docs/search.md#internal-design,
 * docs/testing.md#search). The cases cover bootstrap from snapshots, incremental application,
 * repeated delivery, a batch that fails before its checkpoint commits, an incomplete publication,
 * an expired position that requires a new snapshot, retained unresolved references and the
 * publication of a replacement generation. The database carries Search's schema only, so a
 * provider read reaching storage instead of its publication contract fails these cases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CatalogChange,
  CatalogPublishedRecord,
  CatalogRevision,
} from '../../../src/catalog/index.js';
import {
  createSearchIndexer,
  SEARCH_INDEXING_LIMITS,
  SearchError,
  searchSchemaSql,
  type SearchIndexer,
} from '../../../src/search/index.js';
import type { UserCardsChange, UserCardsPublishedRecord } from '../../../src/usercards/index.js';
import { createTestDatabase, type TestDatabase } from '../../support/postgres-database.js';
import {
  createCatalogPublicationFixture,
  createUserCardsPublicationFixture,
  type CatalogPublicationFixture,
  type UserCardsPublicationFixture,
} from '../../support/search-publications.js';
import { createCrashingTransactor, readScopedProjection } from '../../support/search-projection.js';

const accountId = 'cognito-alice';

function revision(revisionId: string): CatalogRevision {
  return {
    revisionId,
    sourceName: 'scryfall',
    sourceVersion: `snapshot-${revisionId}`,
    publishedAt: '2026-09-28T10:00:00.000Z',
  };
}

const boltCard: CatalogPublishedRecord = {
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
};

const boltName: CatalogPublishedRecord = {
  kind: 'card-name',
  name: { cardId: 'oracle-bolt', language: 'en', name: 'Lightning Bolt' },
};

const boltSpanishName: CatalogPublishedRecord = {
  kind: 'card-name',
  name: { cardId: 'oracle-bolt', language: 'es', name: 'Relámpago' },
};

const m11Printing: CatalogPublishedRecord = {
  kind: 'printing',
  printing: {
    printingId: 'printing-m11-149-en',
    cardId: 'oracle-bolt',
    edition: 'M11',
    collectorNumber: '149',
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: { small: null, normal: null, large: null, artCrop: null },
  },
};

const staPrinting: CatalogPublishedRecord = {
  kind: 'printing',
  printing: {
    printingId: 'printing-sta-109-en',
    cardId: 'oracle-bolt',
    edition: 'STA',
    collectorNumber: '109',
    language: 'en',
    finishes: ['etched'],
    physical: true,
    images: { small: null, normal: null, large: null, artCrop: null },
  },
};

const finishlessDigitalPrinting: CatalogPublishedRecord = {
  kind: 'printing',
  printing: {
    printingId: '4c2abf39-90f5-46c2-b52c-49f2f43fce22',
    cardId: 'oracle-bolt',
    edition: 'ARENA',
    collectorNumber: '1',
    language: 'en',
    finishes: [],
    physical: false,
    images: { small: null, normal: null, large: null, artCrop: null },
  },
};

const counterspellCard: CatalogPublishedRecord = {
  kind: 'card',
  card: {
    cardId: 'oracle-counterspell',
    name: 'Counterspell',
    rulesText: 'Counter target spell.',
    typeLine: 'Instant',
    colors: ['U'],
    colorIdentity: ['U'],
    manaValue: 2,
  },
};

const binderTag: UserCardsPublishedRecord = {
  kind: 'tag',
  tag: { tagId: 'tag-binder', kind: 'location', label: 'Binder', system: false },
};

const boltCopy: UserCardsPublishedRecord = {
  kind: 'copy',
  copy: {
    copyId: 'copy-alice-1',
    printingId: 'printing-m11-149-en',
    finish: 'nonfoil',
    condition: 'NM',
    owned: true,
    locationId: 'tag-binder',
  },
};

const staCopy: UserCardsPublishedRecord = {
  kind: 'copy',
  copy: {
    copyId: 'copy-alice-2',
    printingId: 'printing-sta-109-en',
    finish: 'etched',
    condition: null,
    owned: true,
    locationId: null,
  },
};

/** One distinct card of a publication that spans many pages. */
function fillerCard(index: number): CatalogPublishedRecord {
  return {
    kind: 'card',
    card: {
      cardId: `oracle-filler-${index}`,
      name: `Filler ${index}`,
      rulesText: null,
      typeLine: null,
      colors: [],
      colorIdentity: [],
      manaValue: null,
    },
  };
}

function catalogCardChange(
  position: string,
  revisionId: string,
  record: CatalogPublishedRecord,
  removed = false,
): CatalogChange {
  const reference =
    record.kind === 'card'
      ? ({ kind: 'card', cardId: record.card.cardId } as const)
      : record.kind === 'printing'
        ? ({ kind: 'printing', printingId: record.printing.printingId } as const)
        : ({
            kind: 'card-name',
            cardId: record.name.cardId,
            language: record.name.language,
            name: record.name.name,
          } as const);
  return {
    kind: record.kind,
    position,
    revisionId,
    reference,
    removed,
    record: removed ? null : record,
  };
}

function catalogRevisionChange(position: string, revisionId: string): CatalogChange {
  return { kind: 'revision', position, revision: revision(revisionId) };
}

function copyChange(
  position: string,
  accountRevision: string,
  record: UserCardsPublishedRecord | null,
  copyId: string,
): UserCardsChange {
  return {
    kind: 'copy',
    position,
    accountId,
    revision: accountRevision,
    reference: { kind: 'copy', copyId },
    removed: record === null,
    record,
  };
}

function accountRevisionChange(position: string, accountRevision: string): UserCardsChange {
  return { kind: 'revision', position, accountId, revision: accountRevision };
}

describe('search indexing', () => {
  let database: TestDatabase;
  let catalog: CatalogPublicationFixture;
  let alice: UserCardsPublicationFixture;
  let indexer: SearchIndexer;

  beforeEach(async () => {
    database = await createTestDatabase(searchSchemaSql);
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName, boltSpanishName, m11Printing],
    });
    alice = createUserCardsPublicationFixture({
      accountId,
      position: '4',
      records: [binderTag, boltCopy],
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function readScoped(
    account: string,
    statement: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return await readScopedProjection(database, account, statement);
  }

  async function generationState(): Promise<readonly Readonly<Record<string, unknown>>[]> {
    return await database.query(
      `select generation_id::text as generation_id, state
         from search_private.generation
        order by generation_id`,
    );
  }

  it('bootstraps one generation from the provider snapshots and publishes it', async () => {
    const result = await indexer.index({ accounts: [accountId] });

    expect(result).toMatchObject({
      published: true,
      rebuilt: true,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(result.catalog).toEqual({
      position: '10',
      revisionId: 'revision-1',
      caughtUp: true,
    });
    expect(result.accounts).toEqual([{ accountId, position: '4', caughtUp: true }]);
    expect(await database.query('select card_id, name from search.cards')).toEqual([
      { card_id: 'oracle-bolt', name: 'Lightning Bolt' },
    ]);
    expect(await database.query('select name from search.card_names order by language')).toEqual([
      { name: 'Lightning Bolt' },
      { name: 'Relámpago' },
    ]);
    expect(
      await database.query('select printing_id, edition, finishes from search.printings'),
    ).toEqual([
      {
        printing_id: 'printing-m11-149-en',
        edition: 'M11',
        finishes: ['nonfoil', 'foil'],
      },
    ]);
    expect(await readScoped(accountId, 'select copy_id, location_id from search.copies')).toEqual([
      { copy_id: 'copy-alice-1', location_id: 'tag-binder' },
    ]);
    expect(await readScoped(accountId, 'select tag_id from search.tags')).toEqual([
      { tag_id: 'tag-binder' },
    ]);
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'published' }]);
    expect(
      await database.query('select position, revision_id from search_private.catalog_checkpoint'),
    ).toEqual([{ position: '10', revision_id: 'revision-1' }]);
    expect(
      await database.query('select account_id, position from search_private.account_checkpoint'),
    ).toEqual([{ account_id: accountId, position: '4' }]);
    // The read surface reports the indexed generation and the position the catalog applied.
    expect(
      await database.query('select generation_id, catalog_revision from search.index_state'),
    ).toEqual([{ generation_id: '1', catalog_revision: 'revision-1' }]);
    expect(await readScoped(accountId, 'select position from search.account_state')).toEqual([
      { position: '4' },
    ]);
  });

  it('commits snapshots in set-based record and payload bounded batches and resumes each pass', async () => {
    const records = Array.from({ length: 205 }, (_, index) => fillerCard(index));
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-large'),
      position: '20',
      records,
    });
    alice = createUserCardsPublicationFixture({ accountId, position: '0', records: [] });
    let largestTransaction = 0;
    const boundedSql = {
      query: database.sql.query,
      transaction: async <T>(work: Parameters<typeof database.sql.transaction<T>>[0]) =>
        database.sql.transaction(async (statements) => {
          let requests = 0;
          const result = await work({
            async query(statement, parameters) {
              requests += 1;
              if (requests > 12) throw new Error('oversized transaction');
              return statements.query(statement, parameters);
            },
          });
          largestTransaction = Math.max(largestTransaction, requests);
          return result;
        }),
    };
    indexer = createSearchIndexer({
      sql: boundedSql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    const first = await indexer.index({ accounts: [accountId], maxBatches: 1 });
    expect(first).toMatchObject({ published: false, caughtUp: false, rebuilt: true });
    expect(
      await database.query(
        `select record_offset from search_private.snapshot_progress where source = 'catalog'`,
      ),
    ).toEqual([{ record_offset: 100 }]);

    await indexer.index({ accounts: [accountId], maxBatches: 1 });
    await indexer.index({ accounts: [accountId], maxBatches: 1 });
    const complete = await indexer.index({ accounts: [accountId], maxBatches: 1 });

    expect(complete).toMatchObject({ published: true, caughtUp: true });
    expect(await database.query('select count(*)::int as count from search.cards')).toEqual([
      { count: 205 },
    ]);
    expect(largestTransaction).toBeLessThanOrEqual(12);
  });

  it('resumes partial Catalog and UserCards pages with their persisted page size', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-large'),
      position: '20',
      records: Array.from({ length: 150 }, (_, index) => fillerCard(index)),
    });
    alice = createUserCardsPublicationFixture({
      accountId,
      position: '4',
      records: Array.from({ length: 150 }, (_, index) => ({
        kind: 'tag' as const,
        tag: {
          tagId: `tag-${index}`,
          kind: 'other' as const,
          label: `Tag ${index}`,
          system: false,
        },
      })),
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    const partial = await indexer.index({ accounts: [accountId], pageSize: 500, maxBatches: 1 });
    expect(partial).toMatchObject({ published: false, caughtUp: false });
    expect(
      await database.query(
        `select source, record_offset, page_size from search_private.snapshot_progress
          order by source`,
      ),
    ).toEqual([
      { source: 'account', record_offset: 100, page_size: 500 },
      { source: 'catalog', record_offset: 100, page_size: 500 },
    ]);

    const resumed = await indexer.index({ accounts: [accountId], pageSize: 50, maxBatches: 1 });
    expect(resumed).toMatchObject({ published: false, caughtUp: false });
    const complete = await indexer.index({ accounts: [accountId], pageSize: 50, maxBatches: 1 });

    expect(complete).toMatchObject({ published: true, caughtUp: true });
    expect(await database.query('select count(*)::int as count from search.cards')).toEqual([
      { count: 150 },
    ]);
    expect(await readScoped(accountId, 'select count(*)::int as count from search.tags')).toEqual([
      { count: 150 },
    ]);
  });

  it('resumes a committed staging batch when the caller loses the pass outcome', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-large'),
      position: '20',
      records: Array.from({ length: 101 }, (_, index) => fillerCard(index)),
    });
    alice = createUserCardsPublicationFixture({ accountId, position: '0', records: [] });
    let loseOutcome = true;
    const lostOutcomeSql = {
      query: database.sql.query,
      async transaction<T>(work: Parameters<typeof database.sql.transaction<T>>[0]): Promise<T> {
        const result = await database.sql.transaction(work);
        if (loseOutcome) {
          loseOutcome = false;
          throw new Error('lost response');
        }
        return result;
      },
    };
    indexer = createSearchIndexer({
      sql: lostOutcomeSql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await expect(indexer.index({ accounts: [accountId], maxBatches: 1 })).rejects.toThrow();
    expect(
      await database.query(
        `select record_offset from search_private.snapshot_progress where source = 'catalog'`,
      ),
    ).toEqual([{ record_offset: 100 }]);

    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });
    await indexer.index({ accounts: [accountId], maxBatches: 1 });
    const resumed = await indexer.index({ accounts: [accountId], maxBatches: 1 });
    expect(resumed).toMatchObject({ published: true, caughtUp: true, rebuilt: false });
    expect(await database.query('select count(*)::int as count from search.cards')).toEqual([
      { count: 101 },
    ]);
  });

  it('splits a provider page by encoded payload size', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-payload'),
      position: '20',
      records: Array.from({ length: 3 }, (_, index) => {
        const record = fillerCard(index);
        if (record.kind !== 'card') throw new Error('Expected a card fixture.');
        return { ...record, card: { ...record.card, rulesText: 'x'.repeat(40_000) } };
      }),
    });
    alice = createUserCardsPublicationFixture({ accountId, position: '0', records: [] });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await indexer.index({ accounts: [accountId], maxBatches: 1 });

    expect(
      await database.query(
        `select record_offset from search_private.snapshot_progress where source = 'catalog'`,
      ),
    ).toEqual([{ record_offset: 1 }]);
  });

  it('does not advance staging when a bounded batch rolls back', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-large'),
      position: '20',
      records: Array.from({ length: 101 }, (_, index) => fillerCard(index)),
    });
    alice = createUserCardsPublicationFixture({ accountId, position: '0', records: [] });
    let fail = true;
    const interruptedSql = {
      query: database.sql.query,
      transaction: <T>(work: Parameters<typeof database.sql.transaction<T>>[0]) =>
        database.sql.transaction((statements) =>
          work({
            async query(statement, parameters) {
              if (fail && statement.includes('jsonb_to_recordset')) {
                fail = false;
                throw new Error('interrupted batch');
              }
              return statements.query(statement, parameters);
            },
          }),
        ),
    };
    indexer = createSearchIndexer({
      sql: interruptedSql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await expect(indexer.index({ accounts: [accountId], maxBatches: 1 })).rejects.toThrow();
    expect(await database.query('select * from search_private.snapshot_progress')).toEqual([]);
    expect(await database.query('select count(*)::int as count from search_private.card')).toEqual([
      { count: 0 },
    ]);
  });

  it('applies published upserts and removals with the checkpoint that describes them', async () => {
    await indexer.index({ accounts: [accountId] });

    catalog.publish(
      catalogCardChange('11', 'revision-2', counterspellCard),
      // The second printing must be indexed before the copy that references it can be applied.
      catalogCardChange('12', 'revision-2', staPrinting),
      catalogRevisionChange('13', 'revision-2'),
      catalogCardChange('14', 'revision-3', boltSpanishName, true),
      catalogRevisionChange('15', 'revision-3'),
    );
    alice.publish(copyChange('5', '2', staCopy, 'copy-alice-2'), accountRevisionChange('6', '2'));

    const result = await indexer.index({ accounts: [accountId] });

    expect(result.catalog).toEqual({
      position: '15',
      revisionId: 'revision-3',
      caughtUp: true,
    });
    expect(result.accounts).toEqual([{ accountId, position: '6', caughtUp: true }]);
    expect(await database.query('select card_id from search.cards order by card_id')).toEqual([
      { card_id: 'oracle-bolt' },
      { card_id: 'oracle-counterspell' },
    ]);
    expect(
      await database.query('select language from search.card_names order by language'),
    ).toEqual([{ language: 'en' }]);
    expect(
      await database.query('select position, revision_id from search_private.catalog_checkpoint'),
    ).toEqual([{ position: '15', revision_id: 'revision-3' }]);
    expect(
      await database.query('select copy_id from search_private.copy order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it('projects a nonphysical Catalog printing with no physical finishes', async () => {
    await indexer.index({ accounts: [accountId] });
    await database.exec(
      `alter table search_private.printing drop constraint printing_finishes_check;
       alter table search_private.printing add constraint printing_finishes_check
         check (finishes <@ array['nonfoil', 'foil', 'etched']::text[]
                and cardinality(finishes) >= 1);`,
    );

    await database.exec(searchSchemaSql);
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'published' }]);
    catalog.publish(
      catalogCardChange('11', 'revision-2', finishlessDigitalPrinting),
      catalogRevisionChange('12', 'revision-2'),
    );

    await indexer.index({ accounts: [accountId] });

    expect(
      await database.query(
        `select printing_id, finishes, physical
           from search.printings
          order by printing_id`,
      ),
    ).toEqual([
      {
        printing_id: finishlessDigitalPrinting.printing.printingId,
        finishes: [],
        physical: false,
      },
      {
        printing_id: m11Printing.printing.printingId,
        finishes: ['nonfoil', 'foil'],
        physical: true,
      },
    ]);
  });

  it('leaves the projection and its checkpoints unchanged when a batch fails before it commits', async () => {
    const crashing = createSearchIndexer({
      sql: createCrashingTransactor(database),
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await expect(crashing.index({ accounts: [accountId] })).rejects.toThrow(SearchError);
    // The run started a generation, but no snapshot record or checkpoint was committed with it.
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'building' }]);
    expect(await database.query('select count(*)::int as count from search_private.card')).toEqual([
      { count: 0 },
    ]);
    expect(
      await database.query('select count(*)::int as count from search_private.catalog_checkpoint'),
    ).toEqual([{ count: 0 }]);
    expect(await database.query('select count(*)::int as count from search.cards')).toEqual([
      { count: 0 },
    ]);

    expect(await database.query('select revision_id from search_private.catalog_progress')).toEqual(
      [],
    );

    // The next run resumes the same generation and publishes it.
    const result = await indexer.index({ accounts: [accountId] });
    expect(result).toMatchObject({ published: true, rebuilt: false, caughtUp: true });
    expect(await database.query('select card_id from search.cards')).toEqual([
      { card_id: 'oracle-bolt' },
    ]);
  });

  it('keeps a repeated delivery from changing the projection or its checkpoint', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName, m11Printing],
      changes: [
        catalogCardChange('11', 'revision-2', counterspellCard),
        catalogRevisionChange('12', 'revision-2'),
      ],
      repeatFirstChangePage: true,
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });
    await indexer.index({ accounts: [accountId], pageSize: 1 });
    const cards = await database.query('select * from search_private.card order by card_id');
    const checkpoint = await database.query(
      'select position, revision_id from search_private.catalog_checkpoint',
    );

    const again = await indexer.index({ accounts: [accountId], pageSize: 1 });

    expect(again).toMatchObject({ published: true, rebuilt: false, caughtUp: true });
    expect(await database.query('select * from search_private.card order by card_id')).toEqual(
      cards,
    );
    expect(
      await database.query('select position, revision_id from search_private.catalog_checkpoint'),
    ).toEqual(checkpoint);
    expect(catalog.reads.filter((position) => position === '12').length).toBeGreaterThan(1);
  });

  it('deduplicates a repeated private record page before its completion marker', async () => {
    await indexer.index({ accounts: [accountId] });
    alice = createUserCardsPublicationFixture({
      accountId,
      position: '4',
      records: [binderTag, boltCopy],
      changes: [
        copyChange(
          '5',
          '2',
          { ...boltCopy, copy: { ...boltCopy.copy, locationId: null } },
          'copy-alice-1',
        ),
        accountRevisionChange('6', '2'),
      ],
      repeatFirstChangePage: true,
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    const result = await indexer.index({ accounts: [accountId], pageSize: 1 });

    expect(result.accounts).toEqual([{ accountId, position: '6', caughtUp: true }]);
    expect(await readScoped(accountId, 'select copy_id, location_id from search.copies')).toEqual([
      { copy_id: 'copy-alice-1', location_id: null },
    ]);
  });

  it('does not advance past a publication whose completion was not delivered', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName, m11Printing],
      changes: [
        catalogCardChange('11', 'revision-2', counterspellCard),
        catalogRevisionChange('12', 'revision-2'),
        // The next publication's record was delivered without the marker that completes it.
        catalogCardChange('13', 'revision-3', {
          kind: 'card-name',
          name: { cardId: 'oracle-counterspell', language: 'en', name: 'Counterspell' },
        }),
      ],
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await expect(indexer.index({ accounts: [accountId] })).rejects.toThrow(SearchError);

    expect(await database.query('select position from search_private.catalog_checkpoint')).toEqual([
      { position: '12' },
    ]);
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'building' }]);
    expect(
      await database.query(
        `select count(*)::int as count from search_private.card_name
          where card_id = 'oracle-counterspell'`,
      ),
    ).toEqual([{ count: 0 }]);
    // The publication that did complete stays applied.
    expect(
      await database.query('select card_id from search_private.card order by card_id'),
    ).toEqual([{ card_id: 'oracle-bolt' }, { card_id: 'oracle-counterspell' }]);
  });

  it('restarts an obsolete snapshot instead of mixing two catalog revisions', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName],
      // Page sizes of one let the catalog publish another revision between the snapshot's pages.
      replaceSnapshotAfterFirstPage: {
        revision: revision('revision-2'),
        position: '20',
        records: [boltCard, boltName, counterspellCard, m11Printing],
      },
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    const first = await indexer.index({ accounts: [accountId], pageSize: 1 });
    expect(first).toMatchObject({ published: false, rebuilt: true, caughtUp: false });
    let result = first;
    for (let pass = 0; pass < 4 && !result.published; pass += 1) {
      result = await indexer.index({ accounts: [accountId], pageSize: 500 });
    }

    expect(result).toMatchObject({ published: true, caughtUp: true });
    expect(result.catalog).toEqual({
      position: '20',
      revisionId: 'revision-2',
      caughtUp: true,
    });
    expect(await database.query('select card_id from search.cards order by card_id')).toEqual([
      { card_id: 'oracle-bolt' },
      { card_id: 'oracle-counterspell' },
    ]);
    expect(await database.query('select count(*)::int as count from search.card_names')).toEqual([
      { count: 1 },
    ]);
  });

  it('rebuilds from fresh snapshots when a retained position expired', async () => {
    await indexer.index({ accounts: [accountId] });
    alice.publish(copyChange('5', '2', staCopy, 'copy-alice-2'), accountRevisionChange('6', '2'));
    await indexer.index({ accounts: [accountId] });
    // Retention drops the history below the applied checkpoint: this position cannot be resumed.
    alice.dropHistoryBefore('7');
    alice.replaceSnapshot({ position: '8', records: [binderTag, boltCopy, staCopy] });
    catalog.replaceSnapshot({
      revision: revision('revision-2'),
      position: '20',
      records: [boltCard, boltName, m11Printing, staPrinting],
    });

    const result = await indexer.index({ accounts: [accountId] });

    expect(result).toMatchObject({ published: true, rebuilt: true, caughtUp: true });
    expect(result.accounts).toEqual([{ accountId, position: '8', caughtUp: true }]);
    expect(await generationState()).toEqual([{ generation_id: '2', state: 'published' }]);
    expect(
      await database.query('select copy_id from search_private.copy order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it('keeps the published generation serving while a replacement has an unresolved reference', async () => {
    await indexer.index({ accounts: [accountId] });
    // The account snapshot now carries a copy of a printing the catalog does not publish.
    alice.replaceSnapshot({ position: '8', records: [binderTag, boltCopy, staCopy] });

    const result = await indexer.index({ accounts: [accountId], rebuild: true });

    expect(result).toMatchObject({
      published: false,
      rebuilt: true,
      caughtUp: true,
      unresolvedReferences: 1,
    });
    expect(await generationState()).toEqual([
      { generation_id: '1', state: 'published' },
      { generation_id: '2', state: 'building' },
    ]);
    // The reference is retained in the replacement, and the published generation still answers.
    expect(
      await database.query(
        `select copy_id from search_private.copy
          where generation_id = cast($1 as bigint) order by copy_id`,
        [result.generation],
      ),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
    expect(await readScoped(accountId, 'select copy_id from search.copies')).toEqual([
      { copy_id: 'copy-alice-1' },
    ]);

    // Once the catalog publishes the printing, the same replacement is caught up and published.
    catalog.publish(
      catalogCardChange('21', 'revision-2', staPrinting),
      catalogRevisionChange('22', 'revision-2'),
    );
    const resolved = await indexer.index({ accounts: [accountId] });

    expect(resolved).toMatchObject({
      published: true,
      rebuilt: false,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(await generationState()).toEqual([{ generation_id: '2', state: 'published' }]);
    expect(
      await readScoped(accountId, 'select copy_id from search.copies order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it('keeps a private publication pending until the catalog publishes what it references', async () => {
    await indexer.index({ accounts: [accountId] });

    // A complete private publication references a printing the catalog does not publish yet.
    alice.publish(copyChange('5', '2', staCopy, 'copy-alice-2'), accountRevisionChange('6', '2'));

    const pending = await indexer.index({ accounts: [accountId] });

    expect(pending).toMatchObject({ published: true, caughtUp: false, unresolvedReferences: 0 });
    expect(pending.accounts).toEqual([{ accountId, position: '4', caughtUp: false }]);
    // Nothing of the unresolvable publication was applied and its position did not advance.
    expect(
      await database.query('select account_id, position from search_private.account_checkpoint'),
    ).toEqual([{ account_id: accountId, position: '4' }]);
    expect(await readScoped(accountId, 'select copy_id from search.copies')).toEqual([
      { copy_id: 'copy-alice-1' },
    ]);

    expect(await readScoped(accountId, 'select position from search.account_progress')).toEqual([
      { position: '4' },
    ]);

    // Once the catalog publishes the printing, the pending publication applies completely.
    catalog.publish(
      catalogCardChange('11', 'revision-2', staPrinting),
      catalogRevisionChange('12', 'revision-2'),
    );

    const applied = await indexer.index({ accounts: [accountId] });

    expect(applied).toMatchObject({ published: true, caughtUp: true, unresolvedReferences: 0 });
    expect(applied.accounts).toEqual([{ accountId, position: '6', caughtUp: true }]);
    expect(
      await readScoped(accountId, 'select position from search.account_progress order by position'),
    ).toEqual([{ position: '4' }, { position: '6' }]);
    expect(
      await readScoped(accountId, 'select copy_id from search.copies order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it('holds a new account pending while its snapshot references an unpublished printing', async () => {
    // The generation is published with the catalog only: the account has published nothing yet,
    // so the provider's register does not list it.
    alice.register([]);
    await indexer.index();
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'published' }]);
    alice.register([accountId]);
    alice.replaceSnapshot({ position: '4', records: [binderTag, boltCopy, staCopy] });

    // A routine run covers the account the provider's register reports, without an operator
    // naming it, and holds it pending while its publication cannot resolve.
    const pending = await indexer.index();

    expect(pending).toMatchObject({
      published: true,
      rebuilt: false,
      caughtUp: false,
      unresolvedReferences: 0,
    });
    expect(pending.accounts).toEqual([{ accountId, position: '0', caughtUp: false }]);
    expect(
      await database.query('select count(*)::int as count from search_private.account_checkpoint'),
    ).toEqual([{ count: 0 }]);
    expect(await readScoped(accountId, 'select copy_id from search.copies')).toEqual([]);

    catalog.publish(
      catalogCardChange('11', 'revision-2', staPrinting),
      catalogRevisionChange('12', 'revision-2'),
    );
    const applied = await indexer.index({ accounts: [accountId] });

    expect(applied).toMatchObject({ published: true, caughtUp: true, unresolvedReferences: 0 });
    expect(applied.accounts).toEqual([{ accountId, position: '4', caughtUp: true }]);
    expect(
      await readScoped(accountId, 'select copy_id from search.copies order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it.each([1, 2, 3, 500])(
    'converges when an addition, private correction and removal cross page size %i',
    async (pageSize) => {
      await indexer.index({ accounts: [accountId] });
      catalog.publish(
        catalogCardChange('11', 'revision-2', staPrinting),
        catalogRevisionChange('12', 'revision-2'),
        catalogCardChange('13', 'revision-3', m11Printing, true),
        catalogRevisionChange('14', 'revision-3'),
      );
      alice.publish(
        copyChange(
          '5',
          '2',
          {
            ...staCopy,
            copy: { ...staCopy.copy, copyId: 'copy-alice-1' },
          },
          'copy-alice-1',
        ),
        accountRevisionChange('6', '2'),
      );

      const pending = await indexer.index({ accounts: [accountId], pageSize });
      expect(pending.catalog).toEqual({
        position: '12',
        revisionId: 'revision-2',
        caughtUp: false,
      });
      expect(pending.accounts).toEqual([{ accountId, position: '6', caughtUp: true }]);
      expect(pending.unresolvedReferences).toBe(0);

      const complete = await indexer.index({ accounts: [accountId], pageSize });
      expect(complete).toMatchObject({ published: true, caughtUp: true, unresolvedReferences: 0 });
      expect(complete.catalog.position).toBe('14');
      expect(await database.query('select printing_id from search.printings')).toEqual([
        { printing_id: 'printing-sta-109-en' },
      ]);
      expect(await readScoped(accountId, 'select copy_id, printing_id from search.copies')).toEqual(
        [{ copy_id: 'copy-alice-1', printing_id: 'printing-sta-109-en' }],
      );
    },
  );

  it.each([1, 3, 500])(
    'commits a resolving private correction before a pending private addition at page size %i',
    async (pageSize) => {
      catalog.replaceSnapshot({
        revision: revision('revision-1'),
        position: '10',
        records: [boltCard, boltName, m11Printing, staPrinting],
      });
      await indexer.index({ accounts: [accountId] });
      const newPrinting: CatalogPublishedRecord = {
        ...staPrinting,
        printing: { ...staPrinting.printing, printingId: 'printing-new' },
      };
      catalog.publish(
        catalogCardChange('11', 'revision-2', m11Printing, true),
        catalogRevisionChange('12', 'revision-2'),
        catalogCardChange('13', 'revision-3', newPrinting),
        catalogRevisionChange('14', 'revision-3'),
      );
      alice.publish(
        copyChange(
          '5',
          '2',
          {
            ...staCopy,
            copy: { ...staCopy.copy, copyId: 'copy-alice-1' },
          },
          'copy-alice-1',
        ),
        accountRevisionChange('6', '2'),
        copyChange(
          '7',
          '3',
          {
            ...staCopy,
            copy: { ...staCopy.copy, printingId: 'printing-new' },
          },
          'copy-alice-2',
        ),
        accountRevisionChange('8', '3'),
      );

      const pending = await indexer.index({ accounts: [accountId], pageSize });
      expect(pending.catalog.position).toBe('10');
      expect(pending.accounts).toEqual([{ accountId, position: '6', caughtUp: false }]);
      expect(pending.unresolvedReferences).toBe(0);
      const complete = await indexer.index({ accounts: [accountId], pageSize });
      expect(complete).toMatchObject({ published: true, caughtUp: true, unresolvedReferences: 0 });
      expect(complete.catalog.position).toBe('14');
      expect(complete.accounts).toEqual([{ accountId, position: '8', caughtUp: true }]);
      expect(
        await readScoped(
          accountId,
          'select copy_id, printing_id from search.copies order by copy_id',
        ),
      ).toEqual([
        { copy_id: 'copy-alice-1', printing_id: 'printing-sta-109-en' },
        { copy_id: 'copy-alice-2', printing_id: 'printing-new' },
      ]);
    },
  );

  it.each([1, 2, 500])(
    'holds a catalog removal pending until a later page resolves it (%i)',
    async (pageSize) => {
      let initial = await indexer.index({ accounts: [accountId], pageSize });
      for (let pass = 0; pass < 4 && !initial.published; pass += 1) {
        initial = await indexer.index({ accounts: [accountId], pageSize: 500 });
      }
      expect(initial.published).toBe(true);

      // The catalog drops the card the account's copy belongs to through its printing.
      catalog.publish(
        catalogCardChange('11', 'revision-2', boltCard, true),
        catalogRevisionChange('12', 'revision-2'),
      );

      const pending = await indexer.index({ accounts: [accountId], pageSize });

      expect(pending).toMatchObject({ published: true, caughtUp: false, unresolvedReferences: 0 });
      expect(pending.catalog).toEqual({
        position: '10',
        revisionId: 'revision-1',
        caughtUp: false,
      });
      // The previous usable facts stay queryable while the removal is pending.
      expect(await database.query('select card_id from search.cards')).toEqual([
        { card_id: 'oracle-bolt' },
      ]);
      expect(await readScoped(accountId, 'select copy_id from search.copies')).toEqual([
        { copy_id: 'copy-alice-1' },
      ]);

      // A later publication restores the card, so the pending removal and the restore apply together.
      catalog.publish(
        catalogCardChange('13', 'revision-2', boltCard),
        catalogRevisionChange('14', 'revision-2'),
      );

      const applied = await indexer.index({ accounts: [accountId], pageSize });

      expect(applied.catalog).toEqual({ position: '14', revisionId: 'revision-2', caughtUp: true });
      expect(await database.query('select card_id from search.cards')).toEqual([
        { card_id: 'oracle-bolt' },
      ]);
    },
  );

  it('stages a truncated backlog when its complete prefix remains unresolved', async () => {
    const initial = await indexer.index({ accounts: [accountId] });
    const filler = Array.from({ length: 100 }, (_, index) => fillerCard(index));
    const history = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName, m11Printing],
      changes: [
        catalogCardChange('11', 'revision-2', boltCard, true),
        catalogRevisionChange('12', 'revision-2'),
        ...filler.map((record, index) =>
          catalogCardChange(String(13 + index), 'revision-3', record),
        ),
        catalogCardChange('113', 'revision-3', boltCard),
        catalogRevisionChange('114', 'revision-3'),
      ],
    });
    const latest = createCatalogPublicationFixture({
      revision: revision('revision-3'),
      position: '114',
      records: [boltCard, boltName, m11Printing, ...filler],
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: {
        readSnapshot: (request) => latest.publication.readSnapshot(request),
        readChanges: (request) => history.publication.readChanges(request),
      },
      userCards: alice.publication,
    });

    const recovered = await indexer.index({ accounts: [accountId] });

    expect(recovered).toMatchObject({ published: true, rebuilt: true, caughtUp: true });
    expect(recovered.generation).not.toBe(initial.generation);
    expect(recovered.catalog).toEqual({
      position: '114',
      revisionId: 'revision-3',
      caughtUp: true,
    });
    expect(await database.query('select count(*)::int as count from search.cards')).toEqual([
      { count: 101 },
    ]);
  });

  it('keeps the accounts of an unfinished generation when its position expired', async () => {
    alice.replaceSnapshot({ position: '4', records: [binderTag, boltCopy, staCopy] });

    // The account snapshot cannot be published yet: its copy references an unpublished printing.
    const pending = await indexer.index({ accounts: [accountId] });
    expect(pending).toMatchObject({ published: false, caughtUp: true, unresolvedReferences: 1 });
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'building' }]);

    // Retention expires the generation's catalog position while a fresh snapshot resolves the copy.
    catalog.dropHistoryBefore('20');
    catalog.replaceSnapshot({
      revision: revision('revision-2'),
      position: '20',
      records: [boltCard, boltName, m11Printing, staPrinting],
    });

    const recovered = await indexer.index();

    expect(recovered).toMatchObject({
      published: true,
      rebuilt: false,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(recovered.accounts).toEqual([{ accountId, position: '4', caughtUp: true }]);
    expect(await generationState()).toEqual([{ generation_id: '1', state: 'published' }]);
    expect(
      await readScoped(accountId, 'select copy_id from search.copies order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
  });

  it('applies a publication that spans more pages than a batch used to read', async () => {
    await indexer.index({ accounts: [accountId] });
    const recordCount = 1000;
    const changes: CatalogChange[] = [];
    for (let index = 0; index < recordCount; index += 1) {
      changes.push(catalogCardChange(String(11 + index), 'revision-2', fillerCard(index)));
    }
    changes.push(catalogRevisionChange(String(11 + recordCount), 'revision-2'));
    catalog.publish(...changes);
    const latestRecords: CatalogPublishedRecord[] = [];
    for (const change of changes) {
      if ('record' in change && change.record !== null) latestRecords.push(change.record);
    }
    catalog.replaceSnapshot({
      revision: revision('revision-2'),
      position: String(11 + recordCount),
      records: [boltCard, boltName, boltSpanishName, m11Printing, ...latestRecords],
    });

    const first = await indexer.index({ accounts: [accountId], pageSize: 1 });
    expect(first).toMatchObject({ published: false, caughtUp: false, rebuilt: true });
    let result = first;
    for (let pass = 0; pass < 20 && !result.catalog.caughtUp; pass += 1) {
      result = await indexer.index({ accounts: [accountId], pageSize: 500 });
    }

    expect(result.catalog).toEqual({
      position: String(11 + recordCount),
      revisionId: 'revision-2',
      caughtUp: true,
    });
    expect(await database.query('select count(*)::int as count from search_private.card')).toEqual([
      { count: recordCount + 1 },
    ]);
  });

  it('rejects a provider that repeats a page instead of completing its publication', async () => {
    catalog = createCatalogPublicationFixture({
      revision: revision('revision-1'),
      position: '10',
      records: [boltCard, boltName, m11Printing],
      changes: [catalogCardChange('11', 'revision-2', counterspellCard)],
      repeatFirstChangePage: 'forever',
    });
    indexer = createSearchIndexer({
      sql: database.sql,
      catalog: catalog.publication,
      userCards: alice.publication,
    });

    await expect(indexer.index({ accounts: [accountId], pageSize: 1 })).rejects.toThrow(
      SearchError,
    );

    // The batch is bounded by delivery that never advances, and nothing of it was applied.
    expect(catalog.reads.filter((position) => position === '11')).toHaveLength(
      SEARCH_INDEXING_LIMITS.maxStalledPagesPerBatch + 1,
    );
    expect(await database.query('select position from search_private.catalog_checkpoint')).toEqual([
      { position: '10' },
    ]);
    expect(
      await database.query(
        `select count(*)::int as count from search_private.card
          where card_id = 'oracle-counterspell'`,
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('rejects an indexing request outside the declared bounds', async () => {
    await expect(indexer.index({ accounts: [accountId, accountId] })).rejects.toThrow(SearchError);
    await expect(indexer.index({ pageSize: 0 })).rejects.toThrow(SearchError);
    await expect(indexer.index({ maxBatches: 99 })).rejects.toThrow(SearchError);
    await expect(indexer.index({ accounts: [''] })).rejects.toThrow(SearchError);
    expect(await generationState()).toEqual([]);
  });

  it('indexes without any provider relation in its own storage', async () => {
    const result = await indexer.index({ accounts: [accountId] });

    expect(result.published).toBe(true);
    expect(
      await database.query(
        `select count(*)::int as count from information_schema.tables
          where table_schema in ('catalog', 'usercards')`,
      ),
    ).toEqual([{ count: 0 }]);
  });
});
