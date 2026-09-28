/**
 * Integration scope: freshness over the real publication-to-indexing cooperation
 * (docs/search.md#freshness, docs/testing.md#search). A committed UserCards write carries its
 * publication position; Search reports the last usable indexed result as updating until indexing
 * incorporates that position, and a bounded observation reports delayed, then incorporated once
 * the projection catches up. A delayed projection never becomes an empty collection or a failed
 * write.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrustedUserContext } from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const m11Bolt = {
  printingId: 'printing-bolt-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
};

const staBolt = {
  printingId: 'printing-bolt-sta-109-en',
  cardId: lightningBolt.cardId,
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: true,
};

describe('search freshness over committed writes', () => {
  let database: SearchTestDatabase;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Bolt, staBolt],
    });
    await database.index();
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopy(
    printingId: string,
    finish: 'nonfoil' | 'foil' | 'etched' = 'nonfoil',
  ): Promise<string> {
    const created = await database.userCards.createCopies(alice, {
      printingId,
      finish,
      condition: 'NM',
      quantity: 1,
    });
    return created.publicationPosition;
  }

  it('reports a write of an unindexed account as updating without results', async () => {
    const position = await createCopy(m11Bolt.printingId);

    const page = await database.search.execute(
      { resultLevel: 'copy', requiredPosition: position },
      alice,
    );

    expect(page.status).toBe('updating');
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBeNull();
    expect(page.continuation).toBeNull();
    expect(page.revisions?.catalogRevision).toBe('revision-1');
    expect(page.revisions?.privateRevision).toBeNull();
  });

  it('keeps the last usable indexed result until the required position is incorporated', async () => {
    const first = await createCopy(m11Bolt.printingId);
    await database.index({ accounts: [alice.accountId] });
    const visible = await database.search.execute({ resultLevel: 'copy' }, alice);
    expect(visible.status).toBe('ready');
    expect(visible.entries).toHaveLength(1);

    const second = await createCopy(staBolt.printingId, 'etched');
    const pending = await database.search.execute(
      { resultLevel: 'copy', requiredPosition: second },
      alice,
    );

    // The delayed write is neither an empty collection nor a failure: the result stays usable and
    // reports the indexed position it was evaluated against.
    expect(pending.status).toBe('updating');
    expect(pending.entries.map((entry) => entry.target)).toEqual([
      { kind: 'copy', copyId: expect.any(String) },
    ]);
    expect(pending.totalCount).toBe(1);
    expect(pending.revisions?.privateRevision).toBe(first);

    await database.index({ accounts: [alice.accountId] });
    const caughtUp = await database.search.execute(
      { resultLevel: 'copy', requiredPosition: second },
      alice,
    );

    expect(caughtUp.status).toBe('ready');
    expect(caughtUp.totalCount).toBe(2);
    expect(caughtUp.revisions?.privateRevision).toBe(second);
  });

  it('reports a bounded wait as delayed and incorporated after indexing catches up', async () => {
    const position = await createCopy(m11Bolt.printingId);

    const delayed = await database.search.observe({ positions: [position] }, alice, {
      timeoutMs: 250,
    });
    expect(delayed.state).toBe('delayed');

    await database.index({ accounts: [alice.accountId] });
    const incorporated = await database.search.observe({ positions: [position] }, alice);

    expect(incorporated.state).toBe('incorporated');
    expect(incorporated.revisions?.privateRevision).toBe(position);
  });

  it('requires the published catalog revision and reports the indexed one', async () => {
    const indexed = await database.search.execute({
      resultLevel: 'card',
      requiredCatalogRevision: 'revision-1',
    });
    const ahead = await database.search.execute({
      resultLevel: 'card',
      requiredCatalogRevision: 'revision-2',
    });

    expect(indexed.status).toBe('ready');
    expect(indexed.entries.map((entry) => entry.card.name)).toEqual(['Lightning Bolt']);
    expect(ahead.status).toBe('updating');
    expect(ahead.entries.map((entry) => entry.card.name)).toEqual(['Lightning Bolt']);
  });

  it('validates exact account publication membership through snapshots and changes', async () => {
    const first = await createCopy(m11Bolt.printingId);
    const bob = { accountId: 'cognito-bob' };
    const foreign = (
      await database.userCards.createCopies(bob, {
        printingId: m11Bolt.printingId,
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1,
      })
    ).publicationPosition;
    const second = await createCopy(m11Bolt.printingId);
    await database.index({ accounts: [alice.accountId, bob.accountId] });

    for (const position of [first, second]) {
      expect((await database.search.observe({ positions: [position] }, alice)).state).toBe(
        'incorporated',
      );
      expect(
        (await database.search.execute({ resultLevel: 'copy', requiredPosition: position }, alice))
          .status,
      ).toBe('ready');
    }
    for (const position of [foreign, `00${first}`, '999999']) {
      expect((await database.search.observe({ positions: [position, second] }, alice)).state).toBe(
        'indexing',
      );
      expect(
        (await database.search.execute({ resultLevel: 'copy', requiredPosition: position }, alice))
          .status,
      ).toBe('updating');
    }
    // Incremental publication and then a replacement preserve earlier exact membership.
    const third = await createCopy(m11Bolt.printingId);
    await database.index({ accounts: [alice.accountId] });
    // Carry account evidence even after the provider has expired these early positions.
    for (let commit = 0; commit < 9; commit += 1) {
      await createCopy(m11Bolt.printingId);
      await database.index({ accounts: [alice.accountId] });
    }
    await database.index({ rebuild: true });
    expect(
      (await database.search.observe({ positions: [first, second, third] }, alice)).state,
    ).toBe('incorporated');
    expect((await database.search.observe({ positions: [foreign] }, alice)).state).toBe('indexing');
  });

  it('keeps incorporated catalog revisions ready after advancement and rebuild', async () => {
    for (let revision = 2; revision <= 7; revision += 1) {
      await publishCatalog(database, {
        revisionId: `revision-${revision}`,
        cards: [lightningBolt],
        printings: [m11Bolt, staBolt],
      });
      // A published future revision is not ready until applied.
      expect(
        (await database.search.observe({ catalogRevision: `revision-${revision}` })).state,
      ).toBe('indexing');
      await database.index();
    }
    // revision-1 is now outside the provider's retained change history.
    await database.index({ rebuild: true });
    for (const revision of ['revision-1', 'revision-2', 'revision-7']) {
      expect(
        (await database.search.observe({ catalogRevision: revision }, null, { timeoutMs: 250 }))
          .state,
      ).toBe('incorporated');
      expect(
        (await database.search.execute({ resultLevel: 'card', requiredCatalogRevision: revision }))
          .status,
      ).toBe('ready');
    }
    expect((await database.search.observe({ catalogRevision: 'never-published' })).state).toBe(
      'indexing',
    );
    expect(
      (
        await database.search.execute({
          resultLevel: 'card',
          requiredCatalogRevision: 'revision-8',
        })
      ).status,
    ).toBe('updating');
  });

  it('recovers a lost indexed account position by rebuilding it', async () => {
    const position = await createCopy(m11Bolt.printingId);
    await database.index({ accounts: [alice.accountId] });
    await database.exec('delete from search_private.account_checkpoint');

    const lost = await database.search.observe({ positions: [position] }, alice);
    expect(lost.state).toBe('indexing');
    expect(lost.revisions?.privateRevision).toBeNull();

    await database.index({ accounts: [alice.accountId] });
    const recovered = await database.search.observe({ positions: [position] }, alice);

    expect(recovered.state).toBe('incorporated');
    expect(recovered.revisions?.privateRevision).toBe(position);
  });
});
