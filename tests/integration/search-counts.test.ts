/**
 * Integration scope: Search's private count read over the real Catalog and UserCards query
 * surfaces (docs/search.md#request-and-result, docs/search.md#evaluation-and-grouping). The cases
 * run real PostgreSQL statements against the published views with private fixtures written through
 * UserCards' own contract: owned copies, the distinct physical locations holding them and one
 * tag's intended quantity are the observable promises this read makes, and a count is never
 * inferred from another account's rows or reported as zero when the read cannot answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchError } from '../../src/search/index.js';
import type { TrustedUserContext } from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';

const alice = { accountId: 'cognito-alice' };
const bob = { accountId: 'cognito-bob' };

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
  finishes: ['nonfoil', 'foil'],
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

describe('search counts', () => {
  let database: SearchTestDatabase;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Bolt, staBolt],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function createCopies(
    context: TrustedUserContext,
    printingId: string,
    quantity: number,
    finish: 'nonfoil' | 'foil' | 'etched' = 'nonfoil',
  ): Promise<readonly string[]> {
    const created = await database.userCards.createCopies(context, {
      printingId,
      finish,
      condition: 'NM',
      quantity,
    });
    return created.copies.map((copy) => copy.copyId);
  }

  async function createTag(
    context: TrustedUserContext,
    kind: 'deck' | 'wishlist' | 'location' | 'other',
    label: string,
  ): Promise<string> {
    const created = await database.userCards.createTag(context, { kind, label });
    return created.tag.tagId;
  }

  async function moveCopy(
    context: TrustedUserContext,
    copyId: string,
    locationTagId: string | null,
  ): Promise<void> {
    const read = await database.userCards.readCopies(context, [copyId]);
    const copy = read.copies.get(copyId);
    if (copy === undefined) {
      throw new Error('The fixture copy is missing.');
    }
    await database.userCards.setCopyLocation(context, {
      copyId,
      locationTagId,
      expectedRevision: copy.revision,
    });
  }

  it('counts owned copies across a card’s printings and their distinct locations', async () => {
    const binder = await createTag(alice, 'location', 'Binder');
    const box = await createTag(alice, 'location', 'Box');
    const [first, second] = await createCopies(alice, m11Bolt.printingId, 2);
    const [etched] = await createCopies(alice, staBolt.printingId, 1, 'etched');
    await moveCopy(alice, first as string, binder);
    await moveCopy(alice, second as string, binder);
    await moveCopy(alice, etched as string, box);

    const counts = await database.search.counts(
      {
        references: [
          { kind: 'card', cardId: lightningBolt.cardId },
          { kind: 'printing', printingId: m11Bolt.printingId },
          { kind: 'printing', printingId: staBolt.printingId },
          { kind: 'copy', copyId: first as string },
        ],
      },
      alice,
    );

    expect(counts.counts.get(`card:${lightningBolt.cardId}`)).toEqual({
      owned: 3,
      locations: 2,
      intended: null,
    });
    expect(counts.counts.get(`printing:${m11Bolt.printingId}`)).toEqual({
      owned: 2,
      locations: 1,
      intended: null,
    });
    expect(counts.counts.get(`printing:${staBolt.printingId}`)).toEqual({
      owned: 1,
      locations: 1,
      intended: null,
    });
    expect(counts.counts.get(`copy:${first as string}`)).toEqual({
      owned: 1,
      locations: 1,
      intended: null,
    });
    expect(counts.privateRevision.length).toBeGreaterThan(0);
  });

  it('answers a reference the account holds none of with an exact zero', async () => {
    const counts = await database.search.counts(
      {
        references: [
          { kind: 'card', cardId: lightningBolt.cardId },
          { kind: 'printing', printingId: m11Bolt.printingId },
        ],
      },
      alice,
    );

    expect(counts.counts.get(`card:${lightningBolt.cardId}`)).toEqual({
      owned: 0,
      locations: 0,
      intended: null,
    });
    expect(counts.counts.get(`printing:${m11Bolt.printingId}`)).toEqual({
      owned: 0,
      locations: 0,
      intended: null,
    });
  });

  it('reports one tag’s intent covering the reference and keeps accounts apart', async () => {
    const wishlist = await createTag(alice, 'wishlist', 'To buy');
    await database.userCards.createAssociation(alice, {
      tagId: wishlist,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 2,
    });
    await database.userCards.createAssociation(alice, {
      tagId: wishlist,
      targetLevel: 'printing',
      targetId: staBolt.printingId,
      quantity: 3,
    });
    const [aliceCopy] = await createCopies(alice, m11Bolt.printingId, 1);
    await createCopies(bob, m11Bolt.printingId, 1);
    const bobWishlist = await createTag(bob, 'wishlist', 'Bob buys');
    await database.userCards.createAssociation(bob, {
      tagId: bobWishlist,
      targetLevel: 'printing',
      targetId: m11Bolt.printingId,
      quantity: 9,
    });

    const counts = await database.search.counts(
      {
        references: [
          { kind: 'card', cardId: lightningBolt.cardId },
          { kind: 'printing', printingId: m11Bolt.printingId },
          { kind: 'printing', printingId: staBolt.printingId },
          { kind: 'copy', copyId: aliceCopy as string },
        ],
        tagId: wishlist,
      },
      alice,
    );

    // A card association covers every printing of the card; a printing association covers exactly
    // that printing; a copy reference is covered through its own printing.
    expect(counts.counts.get(`card:${lightningBolt.cardId}`)).toEqual({
      owned: 1,
      locations: 0,
      intended: 5,
    });
    expect(counts.counts.get(`printing:${m11Bolt.printingId}`)).toEqual({
      owned: 1,
      locations: 0,
      intended: 2,
    });
    expect(counts.counts.get(`printing:${staBolt.printingId}`)).toEqual({
      owned: 0,
      locations: 0,
      intended: 5,
    });
    expect(counts.counts.get(`copy:${aliceCopy as string}`)).toEqual({
      owned: 1,
      locations: 0,
      intended: 2,
    });
  });

  it('requires trusted context and rejects unusable references', async () => {
    await expect(
      database.search.counts({ references: [{ kind: 'card', cardId: lightningBolt.cardId }] }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(database.search.counts({ references: [] }, alice)).rejects.toBeInstanceOf(
      SearchError,
    );
    await expect(
      database.search.counts({ references: [{ kind: 'copy', copyId: '' } as never] }, alice),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });
});
