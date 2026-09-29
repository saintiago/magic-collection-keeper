/**
 * Integration scope: Search indexing over the real Catalog and UserCards publications and its own
 * projection storage (docs/data-architecture.md#asynchronous-synchronization,
 * docs/testing.md#search). The providers publish through their own synchronizer and operations, so
 * the cases exercise the actual snapshot/change handoff, account scoping and publication retention
 * instead of fixtures: a bootstrap, later incremental publications, an explicit removal, an
 * expired position that requires a fresh snapshot, and a replacement generation that stays
 * unqueryable while it is incomplete.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCatalogSynchronizer,
  type CatalogSynchronizer,
  type CatalogRevision,
} from '../../src/catalog/index.js';
import { createSearchIndexer, SearchError } from '../../src/search/index.js';
import {
  USERCARDS_PUBLICATION_LIMITS,
  type TrustedUserContext,
} from '../../src/usercards/index.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';
import { createCrashingTransactor, readScopedProjection } from '../support/search-projection.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const boltCardId = 'oracle-lightning-bolt';
const m11PrintingId = 'printing-m11-149-en';
const staPrintingId = 'printing-sta-109-en';

/** One provider record of the catalog job's snapshot format. */
function providerCard(options: {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly finishes?: readonly string[];
}): Record<string, unknown> {
  const finishes = options.finishes ?? ['nonfoil'];
  return {
    object: 'card',
    id: options.printingId,
    oracle_id: boltCardId,
    name: 'Lightning Bolt',
    lang: 'en',
    set: options.edition,
    collector_number: options.collectorNumber,
    finishes,
    nonfoil: finishes.includes('nonfoil'),
    foil: finishes.includes('foil'),
    etched: finishes.includes('etched'),
    digital: false,
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    type_line: 'Instant',
    colors: ['R'],
    color_identity: ['R'],
    cmc: 1,
  };
}

const m11Record = providerCard({
  printingId: m11PrintingId,
  edition: 'm11',
  collectorNumber: '149',
  finishes: ['nonfoil', 'foil'],
});

const staRecord = providerCard({
  printingId: staPrintingId,
  edition: 'sta',
  collectorNumber: '109',
  finishes: ['etched'],
});

describe('search indexing over real publications', () => {
  let database: SearchTestDatabase;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
  });

  afterEach(async () => {
    await database.close();
  });

  function synchronizer(records: readonly unknown[], sourceVersion: string): CatalogSynchronizer {
    return createCatalogSynchronizer({
      sql: database.sql,
      snapshots: createSnapshotSource({ cards: { sourceVersion, records } }),
    });
  }

  async function publishCatalog(
    records: readonly unknown[],
    sourceVersion: string,
  ): Promise<CatalogRevision> {
    return await synchronizer(records, sourceVersion).synchronize({ dataset: 'cards' });
  }

  async function copiesOf(account: TrustedUserContext): Promise<Readonly<unknown[]>> {
    return await readScopedProjection(
      database,
      account.accountId,
      'select copy_id from search.copies',
    );
  }

  it('keeps projection writes uncommitted across provider snapshot transactions', async () => {
    await publishCatalog([m11Record], 'snapshot-1');
    await database.exec('create table transaction_probe (id integer)');
    await expect(
      database.sql.transaction(async (statements) => {
        await statements.query('insert into transaction_probe values (1)');
        await database.catalogPublication.readSnapshot({ pageSize: 1 });
        await database.userCardsPublication.readSnapshot({
          accountId: alice.accountId,
          pageSize: 1,
        });
        throw new Error('Projection interrupted');
      }),
    ).rejects.toThrow('Projection interrupted');
    expect(await database.query('select * from transaction_probe')).toEqual([]);
  });

  it('projects the published catalog and private records and catches up later publications', async () => {
    const revision = await publishCatalog([m11Record], 'snapshot-1');
    await database.userCards.createCopies(alice, {
      printingId: m11PrintingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 2,
    });

    const first = await database.indexer.index({ accounts: [alice.accountId] });

    expect(first).toMatchObject({
      published: true,
      rebuilt: true,
      caughtUp: true,
      unresolvedReferences: 0,
    });
    expect(first.catalog.revisionId).toBe(revision.revisionId);
    expect(await database.query('select card_id, name from search.cards')).toEqual([
      { card_id: boltCardId, name: 'Lightning Bolt' },
    ]);
    expect(await database.query('select printing_id from search.printings')).toEqual([
      { printing_id: m11PrintingId },
    ]);
    expect(await copiesOf(alice)).toHaveLength(2);
    // The private projection is scoped: another account reads none of it.
    expect(await copiesOf(bob)).toEqual([]);
    expect(
      await readScopedProjection(
        database,
        alice.accountId,
        'select position from search.account_state',
      ),
    ).toHaveLength(1);

    // A later catalog revision and a later private write are indexed by the next run.
    const next = await publishCatalog([m11Record, staRecord], 'snapshot-2');
    await database.userCards.createCopies(alice, {
      printingId: staPrintingId,
      finish: 'etched',
      condition: null,
      quantity: 1,
    });

    const second = await database.indexer.index({ accounts: [alice.accountId] });

    expect(second.catalog.revisionId).toBe(next.revisionId);
    expect(second.catalog.revisionId).not.toBe(revision.revisionId);
    expect(
      await database.query('select printing_id from search.printings order by printing_id'),
    ).toEqual([{ printing_id: m11PrintingId }, { printing_id: staPrintingId }]);
    expect(await copiesOf(alice)).toHaveLength(3);

    // Indexing one account leaves another account's data out of it.
    await database.userCards.createCopies(bob, {
      printingId: m11PrintingId,
      finish: 'foil',
      condition: null,
      quantity: 1,
    });
    await database.indexer.index({ accounts: [bob.accountId] });

    expect(await copiesOf(alice)).toHaveLength(3);
    expect(await copiesOf(bob)).toHaveLength(1);
  });

  it('drops an association the account removed from its published records', async () => {
    await publishCatalog([m11Record], 'snapshot-1');
    const tag = await database.userCards.createTag(alice, { kind: 'wishlist', label: 'Wishlist' });
    const created = await database.userCards.createAssociation(alice, {
      tagId: tag.tag.tagId,
      targetLevel: 'card',
      targetId: boltCardId,
      quantity: 2,
    });
    await database.indexer.index({ accounts: [alice.accountId] });
    expect(
      await readScopedProjection(
        database,
        alice.accountId,
        'select association_id, quantity from search.associations',
      ),
    ).toEqual([{ association_id: created.association.associationId, quantity: 2 }]);

    await database.userCards.removeAssociation(alice, {
      associationId: created.association.associationId,
      expectedRevision: created.association.revision,
    });
    await database.indexer.index({ accounts: [alice.accountId] });

    expect(
      await readScopedProjection(
        database,
        alice.accountId,
        'select association_id from search.associations',
      ),
    ).toEqual([]);
    // The tag the association belonged to stays projected.
    expect(
      await readScopedProjection(database, alice.accountId, 'select tag_id from search.tags'),
    ).toEqual([{ tag_id: tag.tag.tagId }]);
  });

  it('rebuilds from a fresh snapshot when the retained private history expired', async () => {
    await publishCatalog([m11Record], 'snapshot-1');
    await database.userCards.createCopies(alice, {
      printingId: m11PrintingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
    });
    await database.indexer.index({ accounts: [alice.accountId] });

    // More mutations than the account's retained publication history leave the indexed position
    // behind the retained window, so it cannot be resumed.
    const laterMutations = USERCARDS_PUBLICATION_LIMITS.retainedRevisions + 1;
    for (let index = 0; index < laterMutations; index += 1) {
      await database.userCards.createCopies(alice, {
        printingId: m11PrintingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 1,
      });
    }

    const result = await database.indexer.index({ accounts: [alice.accountId] });

    expect(result).toMatchObject({ published: true, rebuilt: true, caughtUp: true });
    expect(await copiesOf(alice)).toHaveLength(1 + laterMutations);
  });

  it('keeps the published generation readable while a replacement is incomplete', async () => {
    await publishCatalog([m11Record], 'snapshot-1');
    await database.userCards.createCopies(alice, {
      printingId: m11PrintingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    await database.indexer.index({ accounts: [alice.accountId] });

    // A run whose transactions never commit starts a replacement and dies before it completes.
    const crashed = createSearchIndexer({
      sql: createCrashingTransactor(database),
      catalog: database.catalogPublication,
      userCards: database.userCardsPublication,
    });
    await expect(crashed.index({ accounts: [alice.accountId], rebuild: true })).rejects.toThrow(
      SearchError,
    );

    expect(
      await database.query('select state from search_private.generation order by generation_id'),
    ).toEqual([{ state: 'published' }, { state: 'building' }]);
    // Reads continue over the published generation while the replacement is incomplete.
    expect(await copiesOf(alice)).toHaveLength(1);

    const resumed = await database.indexer.index({ accounts: [alice.accountId] });

    expect(resumed).toMatchObject({ published: true, rebuilt: false, caughtUp: true });
    expect(await database.query('select state from search_private.generation')).toEqual([
      { state: 'published' },
    ]);
    expect(await copiesOf(alice)).toHaveLength(1);
  });
});
