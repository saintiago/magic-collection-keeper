/**
 * Integration scope: the UserInterface's list source over the real Search continuation boundary
 * (docs/user-interface.md#list-boundary, docs/testing.md#contracts-and-cooperation). The binding
 * translates the provider's own failure semantics into the list contract, so a continuation the
 * changed revisions invalidated is reported as an invalidation the list restarts, while a
 * temporary evaluation failure stays a rejection the list retries at the position it asked for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SearchClient } from '../../src/application/index.js';
import {
  catalogQuerySource,
  type CardListCatalogQuery as UiCatalogQuery,
} from '../../src/card-list/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import { createSearchTestDatabase, type SearchTestDatabase } from '../support/search-database.js';

const bolt = {
  cardId: 'oracle-bolt',
  name: 'Lightning Bolt',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const elves = {
  cardId: 'oracle-elves',
  name: 'Llanowar Elves',
  typeLine: 'Creature — Elf Druid',
  colors: ['G'],
  colorIdentity: ['G'],
  manaValue: 1,
};

const boltPrinting = {
  printingId: 'printing-bolt-m11-149-en',
  cardId: bolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil'],
};

const elvesPrinting = {
  printingId: 'printing-elves-m11-175-en',
  cardId: elves.cardId,
  edition: 'M11',
  collectorNumber: '175',
  language: 'en',
  finishes: ['nonfoil'],
};

const query: UiCatalogQuery = { text: '', level: 'card', owned: false, finish: null };

describe('list source recovery over Search', () => {
  let database: SearchTestDatabase;
  let source: ReturnType<typeof catalogQuerySource>;

  beforeEach(async () => {
    database = await createSearchTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [bolt, elves],
      printings: [boltPrinting, elvesPrinting],
    });
    // Search answers from its own projection, so the fixtures are indexed before the list reads.
    await database.index();
    // The browser reaches the component contracts through Application's authenticated clients:
    // this read evaluates the public query without a trusted account, as the catalog page does.
    const search = {
      execute: (request: Parameters<SearchClient['execute']>[0]) =>
        database.search.execute(request, null),
      counts: () => Promise.reject(new Error('The list source reads no private counts.')),
      observe: (request) => database.search.observe(request, null),
    } satisfies SearchClient;
    source = catalogQuerySource(search);
  });

  afterEach(async () => {
    await database.close();
  });

  async function firstPage(): Promise<string> {
    const read = await source.load({
      context: query,
      pageSize: 1,
      continuation: null,
      signal: new AbortController().signal,
      required: { positions: [] },
    });
    if (read.status !== 'page' || read.continuation === null) {
      throw new Error('The search did not offer a further page.');
    }
    return read.continuation;
  }

  it('reports a continuation the changed catalog revision invalidated', async () => {
    const continuation = await firstPage();
    await publishCatalog(database, {
      revisionId: 'revision-2',
      cards: [bolt, elves],
      printings: [boltPrinting, elvesPrinting],
    });
    await database.index({ rebuild: true });

    await expect(
      source.load({
        context: query,
        pageSize: 1,
        continuation,
        signal: new AbortController().signal,
        required: { positions: [] },
      }),
    ).resolves.toEqual({ status: 'invalidated' });
  });

  it('keeps a temporary failure a rejection at the position it asked for', async () => {
    const continuation = await firstPage();
    await database.exec('drop view search.cards');

    await expect(
      source.load({
        context: query,
        pageSize: 1,
        continuation,
        signal: new AbortController().signal,
        required: { positions: [] },
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
