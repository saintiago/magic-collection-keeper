import { describe, expect, it, vi } from 'vitest';
import {
  createCardList,
  catalogQuerySource,
  collectionQuerySource,
  entryOwnershipReader,
  userCardsCounts,
} from '../../../src/card-list/index.js';
import { createCatalogClient, createUserCardsClient } from '../../../src/application/index.js';
import { createUserCardsOperations } from '../../../src/usercards/browser.js';
import { unusedUserCardsClient } from '../../support/usercards-browser.js';
import {
  publicPage,
  privatePage,
  fixtureResolution,
  type QueryEntryFixture,
} from '../../browser/query-fixtures.js';
const entry: QueryEntryFixture = {
  entryKey: 'card:bolt',
  target: { kind: 'card', cardId: 'bolt' },
  card: { cardId: 'bolt', name: 'Lightning Bolt', matchedName: null },
  printing: null,
  quantity: { copies: 2, intended: null },
};
const fixture = { entries: [entry], totalCount: 1, continuation: null };
const catalog = () => ({
  query: vi.fn(async () => publicPage(fixture)),
  resolve: vi.fn(async (refs: Parameters<typeof fixtureResolution>[1]) =>
    fixtureResolution([entry], refs),
  ),
  listCardPrintings: vi.fn(),
});
async function settled() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
describe('direct owner query composition', () => {
  it('preserves public membership while refreshing private fragments, including failures', async () => {
    const publicOwner = catalog();
    let owned = 2;
    const readFragments = vi.fn(async () => ({
      privateRevision: '1',
      missing: [],
      fragments: new Map([
        [
          'card:bolt',
          {
            reference: entry.target,
            ownedCopyCount: owned,
            physicalLocationCount: 0,
            intendedQuantity: null,
            tagIds: [],
          },
        ],
      ]),
    }));
    const privateOwner = { query: vi.fn(), readCopies: vi.fn(), readFragments };
    const list = createCardList({
      accountId: 'alice',
      pageSize: 50,
      context: { text: '', level: 'card' as const, owned: false, finish: null },
      source: catalogQuerySource(publicOwner),
      fragments: { ownership: entryOwnershipReader(userCardsCounts(privateOwner)) },
    });
    await settled();
    expect(list.snapshot().entries).toHaveLength(1);
    owned = 3;
    list.changed({ scope: 'copies', records: [], imports: [] });
    await settled();
    expect(publicOwner.query).toHaveBeenCalledTimes(1);
    expect(readFragments).toHaveBeenCalledTimes(2);
    expect(list.snapshot().entries[0]?.entry.quantity).toBeNull();
    readFragments.mockRejectedValueOnce(new Error('Read unavailable'));
    list.changed({ scope: 'copies', records: [], imports: [] });
    await settled();
    expect(list.snapshot().entries).toHaveLength(1);
    expect(publicOwner.query).toHaveBeenCalledTimes(1);
    list.dispose();
  });
  it('resolves private membership in batches and preserves owner quantities and continuation', async () => {
    const owner = catalog();
    const query = vi.fn(async () => ({ ...privatePage(fixture), continuation: 'next' }));
    const readCopies = vi.fn();
    const source = collectionQuerySource({ query, readCopies, readFragments: vi.fn() }, owner);
    const page = await source.load({
      context: { text: '', level: 'card' },
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
    });
    expect(query).toHaveBeenCalledWith(
      { scope: { kind: 'collection' }, resultLevel: 'card', pageSize: 50 },
      expect.any(AbortSignal),
    );
    expect(owner.resolve).toHaveBeenCalledOnce();
    expect(readCopies).not.toHaveBeenCalled();
    expect(page).toMatchObject({
      status: 'page',
      continuation: 'next',
      entries: [
        {
          key: 'card:bolt',
          basic: { card: { name: 'Lightning Bolt' } },
          quantity: { copies: 2, intended: null },
        },
      ],
    });
  });
  it('fences superseded refreshes and keeps usable private content when the latest read fails', async () => {
    const owner = catalog();
    const stale = Promise.withResolvers<ReturnType<typeof privatePage>>();
    const query = vi.fn(async () => privatePage(fixture));
    const list = createCardList({
      accountId: 'alice',
      pageSize: 50,
      context: { text: '', level: 'card' as const },
      source: collectionQuerySource({ query, readCopies: vi.fn(), readFragments: vi.fn() }, owner),
    });
    await settled();
    query
      .mockImplementationOnce(() => stale.promise)
      .mockRejectedValueOnce(new Error('Read failed'));
    list.changed({ scope: 'copies', records: [], imports: [] });
    expect(list.snapshot()).toMatchObject({
      loading: true,
      entries: [{ entry: { key: 'card:bolt' } }],
    });
    list.changed({ scope: 'copies', records: [], imports: [] });
    await settled();
    stale.resolve(privatePage({ entries: [], totalCount: 0, continuation: null }));
    await settled();
    expect(list.snapshot()).toMatchObject({
      loading: false,
      error: 'Read failed',
      entries: [{ entry: { key: 'card:bolt' } }],
    });
    list.dispose();
  });
  it('dispatches owner reads through the browser clients and rejects departed account scopes', async () => {
    const request = vi.fn(async (path: string) =>
      path === '/api/catalog/query' ? publicPage(fixture) : privatePage(fixture),
    );
    expect(await createCatalogClient(request).query({ resultLevel: 'card' })).toMatchObject({
      totalCount: 1,
    });
    const operations = createUserCardsOperations({
      client: { ...unusedUserCardsClient(), query: createUserCardsClient(request).query },
    });
    const scope = operations.account('alice');
    expect(await scope.query({ scope: { kind: 'collection' }, resultLevel: 'card' })).toMatchObject(
      { totalCount: 1 },
    );
    operations.release('alice');
    await expect(
      scope.query({ scope: { kind: 'collection' }, resultLevel: 'card' }),
    ).rejects.toThrow();
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/api/catalog/query',
      '/api/collection/query',
    ]);
  });
});
