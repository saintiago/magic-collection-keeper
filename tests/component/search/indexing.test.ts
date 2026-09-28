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

  it('applies published upserts and removals with the checkpoint that describes them', async () => {
    await indexer.index({ accounts: [accountId] });

    catalog.publish(
      catalogCardChange('11', 'revision-2', counterspellCard),
      catalogRevisionChange('12', 'revision-2'),
      catalogCardChange('13', 'revision-3', boltSpanishName, true),
      catalogRevisionChange('14', 'revision-3'),
    );
    alice.publish(copyChange('5', '2', staCopy, 'copy-alice-2'), accountRevisionChange('6', '2'));

    const result = await indexer.index({ accounts: [accountId] });

    expect(result.catalog).toEqual({
      position: '14',
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
    ).toEqual([{ position: '14', revision_id: 'revision-3' }]);
    expect(
      await database.query('select copy_id from search_private.copy order by copy_id'),
    ).toEqual([{ copy_id: 'copy-alice-1' }, { copy_id: 'copy-alice-2' }]);
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
    await indexer.index({ accounts: [accountId] });
    const cards = await database.query('select * from search_private.card order by card_id');
    const checkpoint = await database.query(
      'select position, revision_id from search_private.catalog_checkpoint',
    );

    const again = await indexer.index({ accounts: [accountId] });

    expect(again).toMatchObject({ published: true, rebuilt: false, caughtUp: true });
    expect(await database.query('select * from search_private.card order by card_id')).toEqual(
      cards,
    );
    expect(
      await database.query('select position, revision_id from search_private.catalog_checkpoint'),
    ).toEqual(checkpoint);
    expect(catalog.reads.filter((position) => position === '12').length).toBeGreaterThan(1);
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

    const result = await indexer.index({ accounts: [accountId], pageSize: 1 });

    expect(result).toMatchObject({ published: true, rebuilt: true, caughtUp: true });
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
