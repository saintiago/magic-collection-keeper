import { createSearchProgress } from '../../../src/search/browser.js';
/**
 * Component scope: the source bindings of CardList (docs/card-list.md#interface,
 * docs/card-list.md#required-interfaces-and-source-bindings, docs/search.md#scryfall-compatibility).
 *
 * The Search request a query binding builds, the entries it presents, the private counts it reads
 * as one bounded fragment and the account-local recent-activity store are asserted here; the list
 * behavior built on these bindings is exercised without a rendering dependency in
 * tests/component/card-list/card-list.test.ts and as browser journeys through the UserInterface.
 */

import { describe, expect, it } from 'vitest';

import type { SearchClient } from '../../../src/application/index.js';
import type { Catalog, CatalogReference } from '../../../src/catalog/index.js';
import { SearchError, normalizeSearchRequest, searchEntryKey } from '../../../src/search/index.js';
import {
  CARD_LIST_LIMITS,
  cardListEntryKey,
  catalogQueryRequest,
  catalogQuerySource,
  createCardListBrowser,
  createRecentActivity,
  entryOwnershipReader,
  pendingEntriesBinding,
  printingImagesReader,
  searchCounts,
  searchEntryOf,
  tagAssociationsBinding,
  type CardListCatalogQuery,
  type CardListChange,
  type CardListEntry,
} from '../../../src/card-list/index.js';

const caller = { accountId: 'browse-account' };

/** One catalog query with the controls a browsing page presents. */
function query(overrides: Partial<CardListCatalogQuery> = {}): CardListCatalogQuery {
  return {
    text: '',
    level: 'card',
    owned: false,
    finish: null,
    ...overrides,
  };
}

/** One search entry as the Search contract returns it. */
function entry(): Parameters<typeof searchEntryOf>[0] {
  return {
    entryKey: 'printing:printing-1',
    target: { kind: 'printing', printingId: 'printing-1' },
    card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: 'Blitzschlag' },
    printing: {
      printingId: 'printing-1',
      edition: 'M11',
      collectorNumber: '149',
      language: 'en',
    },
    quantity: { copies: 2, intended: null },
  };
}

/** One list entry of a browsing list, with the basic information Home presents. */
function listEntry(key: string, cardId: string): CardListEntry {
  return {
    key,
    target: { kind: 'card', cardId },
    basic: { card: { cardId, name: 'Lightning Bolt', matchedName: null }, printing: null },
    quantity: null,
  };
}

/** The catalog query's binding over the supplied contracts, as the browsing page composes it. */
function createCatalogSearchAccess(search: SearchClient, catalog: Catalog) {
  return { source: catalogQuerySource(search), images: printingImagesReader(catalog) };
}

describe('catalog search requests', () => {
  it('sends the text expression, the result level and the page boundary', () => {
    expect(
      catalogQueryRequest(query({ text: ' bolt ', level: 'printing' }), 25, 'cursor-1'),
    ).toEqual({
      resultLevel: 'printing',
      query: 'bolt',
      pageSize: 25,
      continuation: 'cursor-1',
    });
    expect(catalogQueryRequest(query(), 50, null)).toEqual({ resultLevel: 'card', pageSize: 50 });
  });

  it('turns the structured controls into the same criteria as their text expressions', () => {
    const controls = normalizeSearchRequest(
      catalogQueryRequest(query({ owned: true, finish: 'foil' }), 50, null),
      caller,
    );
    const expression = normalizeSearchRequest(
      { resultLevel: 'card', query: 'is:foil', criteria: [{ kind: 'owned' }], pageSize: 50 },
      caller,
    );

    expect(controls).toEqual(expression);
  });

  it('requires trusted context for the owned-only control', () => {
    expect(() =>
      normalizeSearchRequest(catalogQueryRequest(query({ owned: true }), 50, null), null),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
  });
});

describe('catalog list entries', () => {
  it('presents the provider key, target, basic information and quantities', () => {
    expect(searchEntryOf(entry())).toEqual({
      key: 'printing:printing-1',
      target: { kind: 'printing', printingId: 'printing-1' },
      basic: {
        card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: 'Blitzschlag' },
        printing: {
          printingId: 'printing-1',
          edition: 'M11',
          collectorNumber: '149',
          language: 'en',
        },
      },
      quantity: { copies: 2, intended: null },
    });
  });

  it('keys each result level by the identity it carries', () => {
    // The images reader names a printing back from the entry key, so the list boundary keeps the
    // key the Search contract derives from the target.
    for (const target of [
      { kind: 'card', cardId: 'card-1' },
      { kind: 'printing', printingId: 'printing-1' },
      { kind: 'copy', copyId: 'copy-1' },
    ] as const) {
      expect(cardListEntryKey(target)).toBe(searchEntryKey(target));
    }
  });

  it('validates the contracts it reads through', () => {
    expect(() => createCatalogSearchAccess(undefined as never, {} as never)).toThrow(TypeError);
    expect(() =>
      createCatalogSearchAccess(
        {
          execute: () => Promise.resolve({}) as never,
          counts: () => Promise.resolve({}) as never,
          observe: () => Promise.resolve({}) as never,
        },
        {} as never,
      ),
    ).toThrow(TypeError);
  });

  it('reports an invalidated continuation instead of failing the read', async () => {
    let failure = 'stale-continuation';
    const access = createCatalogSearchAccess(
      {
        execute: () => Promise.reject(new SearchError(failure as never, 'The catalog changed.')),
        counts: () => Promise.reject(new Error('The list source reads no private counts.')),
      } as never,
      { resolve: () => Promise.reject(new Error('The list source reads no images.')) } as never,
    );
    const request = {
      context: query(),
      pageSize: 50,
      continuation: 'cursor-1',
      signal: new AbortController().signal,
      required: { positions: [] },
    };

    // A continuation the provider invalidated tells the list to restart the sequence; the same
    // failure on a request that names no continuation stays the read's own failure, and a
    // temporary failure stays retryable at its position.
    await expect(access.source.load(request)).resolves.toEqual({ status: 'invalidated' });
    failure = 'unavailable';
    await expect(access.source.load(request)).rejects.toMatchObject({ code: 'unavailable' });
    failure = 'stale-continuation';
    await expect(access.source.load({ ...request, continuation: null })).rejects.toMatchObject({
      code: 'stale-continuation',
    });
  });

  it('establishes every required position through Search’s own observation', async () => {
    const observed: { readonly positions: readonly string[] }[] = [];
    const access = createCatalogSearchAccess(
      {
        execute: () =>
          Promise.resolve({
            status: 'ready',
            entries: [],
            totalCount: 0,
            continuation: null,
            revisions: null,
          }),
        counts: () => Promise.reject(new Error('The list source reads no private counts.')),
        observe: (request: { readonly positions?: readonly string[] | null }) => {
          observed.push({ positions: [...(request.positions ?? [])] });
          return Promise.resolve({
            state: 'indexing' as const,
            revisions: null,
          });
        },
      } as never,
      { resolve: () => Promise.reject(new Error('The list source reads no images.')) } as never,
    );
    const request = {
      context: query(),
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
      required: { positions: ['20', '10'] },
    };

    // An answer that incorporated one named position never stands for the whole requirement: the
    // page stays updating until the provider established every position the read required.
    await expect(access.source.load(request)).resolves.toMatchObject({ current: false });
    expect(observed).toEqual([{ positions: ['20', '10'] }]);
    await expect(
      access.source.load({ ...request, required: { positions: ['10'] } }),
    ).resolves.toMatchObject({ current: true });
  });

  it('acquires the presented page after establishing every opaque required identity', async () => {
    let indexed = false;
    const order: string[] = [];
    const source = catalogQuerySource({
      observe: async () => {
        order.push('observe');
        indexed = true;
        return { state: 'incorporated', revisions: null };
      },
      execute: async () => {
        order.push('query');
        return {
          status: 'ready',
          entries: [],
          totalCount: indexed ? 1 : 0,
          continuation: indexed ? 'new-generation' : null,
          revisions: null,
        } as never;
      },
    });
    const result = await source.load({
      context: query(),
      pageSize: 1,
      continuation: null,
      required: { positions: Array.from({ length: 101 }, (_, i) => String(101 - i)) },
      signal: new AbortController().signal,
    });
    expect(order).toEqual(['observe', 'observe', 'observe', 'query']);
    expect(result).toMatchObject({ current: true, continuation: 'new-generation' });
  });

  it('observes the awaited positions in bounded batches within the declared window', async () => {
    const observed: { readonly positions: readonly string[]; readonly timeoutMs?: number }[] = [];
    const access = createCatalogSearchAccess(
      {
        execute: () => Promise.reject(new Error('This binding only observes progress.')),
        counts: () => Promise.reject(new Error('The list source reads no private counts.')),
        observe: (
          _request: { readonly positions?: readonly string[] | null },
          options?: { readonly timeoutMs?: number },
        ) => {
          observed.push({ positions: [], timeoutMs: options?.timeoutMs });
          return Promise.resolve({ state: 'delayed' as const, revisions: null });
        },
      } as never,
      { resolve: () => Promise.reject(new Error('The list source reads no images.')) } as never,
    );
    const source = access.source;
    expect(typeof source.observe).toBe('function');
    const signal = new AbortController().signal;
    await expect(source.observe!({ positions: ['7'], signal })).resolves.toBe('delayed');
    expect(observed[0]?.timeoutMs).toBeGreaterThan(0);
    // A source without the capability never claims an observation answered.
    const without = createCatalogSearchAccess(
      {
        execute: () => Promise.reject(new Error('No reads.')),
        counts: () => Promise.reject(new Error('No reads.')),
      } as never,
      { resolve: () => Promise.reject(new Error('No reads.')) } as never,
    );
    expect(without.source.observe).toBeUndefined();
  });
});

describe('private counts of explicit entries', () => {
  const counts = (
    references: readonly {
      readonly kind: 'card' | 'printing' | 'copy';
      readonly cardId?: string;
      readonly printingId?: string;
      readonly copyId?: string;
    }[],
  ) => ({
    privateRevision: 'private-1',
    counts: new Map(
      references.map((reference) => [
        `${reference.kind}:${reference.cardId ?? reference.printingId ?? reference.copyId ?? ''}`,
        { owned: 2, locations: 1, intended: reference.kind === 'card' ? 3 : null },
      ]),
    ),
  });

  it('reads the presented entries in one bounded request and keys the answer by entry', async () => {
    const requests: unknown[] = [];
    const access = searchCounts({
      execute: () => Promise.reject(new Error('The counts read runs no query.')),
      counts: (request: {
        readonly references: readonly { readonly kind: 'card' | 'printing' | 'copy' }[];
      }) => {
        requests.push(request);
        return Promise.resolve(counts(request.references));
      },
    } as never);

    const read = await access.ofBatch(
      [
        { kind: 'card', cardId: 'card-1' },
        { kind: 'printing', printingId: 'printing-1' },
      ],
      'tag-wish',
      new AbortController().signal,
    );

    expect(requests).toEqual([
      {
        references: [
          { kind: 'card', cardId: 'card-1' },
          { kind: 'printing', printingId: 'printing-1' },
        ],
        tagId: 'tag-wish',
      },
    ]);
    expect(read.get('card:card-1')).toEqual({ owned: 2, locations: 1, intended: 3 });
    expect(read.get('printing:printing-1')).toEqual({
      owned: 2,
      locations: 1,
      intended: null,
    });
  });

  it('reports an unavailable read as a failure instead of an inferred zero', async () => {
    const access = searchCounts({
      execute: () => Promise.reject(new Error('The counts read runs no query.')),
      counts: () => Promise.reject(new Error('The service is down.')),
    } as never);

    await expect(
      access.ofBatch([{ kind: 'card', cardId: 'card-1' }], null, new AbortController().signal),
    ).rejects.toThrow('The service is down.');
  });

  it('presents the owned and location counts of the entries a fragment names', async () => {
    const access = searchCounts({
      execute: () => Promise.reject(new Error('The counts read runs no query.')),
      counts: (request: {
        readonly references: readonly { readonly kind: 'card' | 'printing' | 'copy' }[];
      }) => Promise.resolve(counts(request.references)),
    } as never);
    const reader = entryOwnershipReader(access);

    const read = await reader.read({
      keys: ['card:card-1', 'association:association-1'],
      information: ['ownership'],
      signal: new AbortController().signal,
    });

    expect(read).toEqual([
      { key: 'card:card-1', status: 'ready', values: { owned: 2, locations: 1, intended: 3 } },
      { key: 'association:association-1', status: 'absent', values: null },
    ]);
  });
});

describe('browser composition of CardList', () => {
  it('reacquires the account’s outstanding positions for a list composed later', async () => {
    const listeners = new Set<(change: unknown) => void>();
    const observed: { readonly positions: readonly string[] }[] = [];
    const search = {
      execute: () => Promise.reject(new Error('The composition runs no query.')),
      counts: () => Promise.reject(new Error('The composition reads no counts.')),
      observe: (request: { readonly positions?: readonly string[] | null }) => {
        observed.push({ positions: [...(request.positions ?? [])] });
        return Promise.resolve({ state: 'incorporated' as const, revisions: null });
      },
    };
    const catalog = {
      resolve: () => Promise.reject(new Error('The composition reads no catalog.')),
      listCardPrintings: () => Promise.reject(new Error('The composition reads no catalog.')),
    };
    const userCards = {
      account: () => ({
        constraints: { batch: { references: 50 } },
        subscribe: (listener: (change: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    };
    const progress = createSearchProgress({ accountId: 'alice', read: search.observe });
    userCards.account().subscribe((value) => {
      progress.committed([(value as { position: string }).position]);
    });
    const cardList = createCardListBrowser({
      progress: () => progress,
      search: search as never,
      catalog: catalog as never,
      userCards: userCards as never,
    });

    const first: CardListChange[] = [];
    const unsubscribe = cardList
      .account('alice')
      .changes()
      .subscribe((change) => first.push(change));
    for (const listener of listeners) {
      listener({ scope: 'copies', records: [], imports: [], position: '7' });
    }
    expect(first).toEqual([{ scope: 'copies', records: [], imports: [], position: '7' }]);
    unsubscribe();
    for (const listener of listeners)
      listener({ scope: 'copies', records: [], imports: [], position: '8' });

    // A list composed later is told to await the position the account still holds, so leaving and
    // reopening a page never turns a known committed change into an apparently current result.
    const second: CardListChange[] = [];
    cardList
      .account('alice')
      .changes()
      .subscribe((change) => second.push(change));
    expect(second.map((change) => change.position)).toEqual(['7', '8']);

    // The composition checks the positions through Search's own bounded observation, so a list
    // composed after their incorporation is not made to await them.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(observed.flatMap((read) => read.positions)).toContain('7');
    const third: CardListChange[] = [];
    cardList
      .account('alice')
      .changes()
      .subscribe((change) => third.push(change));
    expect(third).toEqual([]);
    cardList.endAccount('alice');
    progress.dispose();
  });
});

it('checks copy existence in provider-sized batches before offering tools', async () => {
  const requests: readonly string[][] = [];
  const calls = requests as string[][];
  const browser = createCardListBrowser({
    search: {
      execute: async () => {
        throw new Error('No query');
      },
      counts: async () => {
        throw new Error('No counts');
      },
    },
    catalog: {
      resolve: async () => {
        throw new Error('No lookup');
      },
      listCardPrintings: async () => {
        throw new Error('No printings');
      },
    } as never,
    progress: () => ({
      status: () => ({ accountId: 'alice', state: 'idle', outstanding: [], revisions: null }),
    }),
    userCards: {
      account: () =>
        ({
          constraints: { batch: { references: 1 } },
          readCopies: async (ids: readonly string[]) => {
            calls.push([...ids]);
            return {
              copies: new Map(ids.filter((id) => id !== 'deleted').map((id) => [id, {}])),
              missing: [],
            };
          },
        }) as never,
    },
  });
  const reader = browser.account('alice').copyTools(['edit']);
  const results = await reader.read({
    keys: ['copy:present', 'copy:deleted', 'card:card-1'],
    information: ['tools'],
    signal: new AbortController().signal,
  });
  expect(calls).toEqual([['present'], ['deleted']]);
  expect(results).toEqual([
    { key: 'copy:present', status: 'ready', values: ['edit'] },
    { key: 'copy:deleted', status: 'ready', values: [] },
    { key: 'card:card-1', status: 'ready', values: [] },
  ]);
  browser.endAccount('alice');
});

describe('pending-import and tag-association bindings', () => {
  it('translates one import’s pending entries and keeps their provider records', async () => {
    const requests: { readonly sessionId: string; readonly pageSize?: number }[] = [];
    const binding = pendingEntriesBinding({
      entries: {
        entries: (input) => {
          requests.push({ sessionId: input.sessionId, pageSize: input.pageSize });
          return Promise.resolve({
            privateRevision: 'private-1',
            session: {
              sessionId: input.sessionId,
              sourceKind: 'manual',
              sourceId: 'manual',
              state: 'pending',
              pendingEntries: 1,
              confirmedEntries: 0,
              discardedEntries: 0,
              sourceReference: null,
              revision: 3,
            },
            entries: [
              {
                entryId: 'entry-1',
                sessionId: input.sessionId,
                position: 0,
                state: 'pending',
                printingId: 'printing-1',
                finish: 'nonfoil',
                condition: 'NM',
                quantity: 2,
                candidates: [],
                sourceLine: null,
                revision: 4,
              },
              {
                entryId: 'entry-2',
                sessionId: input.sessionId,
                position: 1,
                state: 'pending',
                printingId: null,
                finish: null,
                condition: null,
                quantity: 1,
                candidates: [],
                sourceLine: null,
                revision: 1,
              },
            ],
            continuation: 'next',
          });
        },
      },
      catalog: {
        resolve: (references: readonly CatalogReference[]) =>
          Promise.resolve({
            revision: {
              revisionId: 'r',
              sourceName: 'fixture',
              sourceVersion: '1',
              publishedAt: '',
            },
            cards: new Map([['card-bolt', { cardId: 'card-bolt', name: 'Lightning Bolt' }]]),
            printings: new Map(
              references.flatMap((reference) =>
                reference.kind === 'printing'
                  ? [
                      [
                        reference.printingId,
                        {
                          printingId: reference.printingId,
                          cardId: 'card-bolt',
                          edition: 'M11',
                          collectorNumber: '149',
                          language: 'en',
                          finishes: ['nonfoil'],
                        },
                      ] as const,
                    ]
                  : [],
              ),
            ),
            missing: [],
          }) as never,
      } as never,
    });

    const page = await binding.source.load({
      context: 'manual',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
      required: { positions: [] },
    });
    expect(requests).toEqual([{ sessionId: 'manual', pageSize: 50 }]);
    expect(page).toMatchObject({
      status: 'page',
      current: true,
      continuation: 'next',
      entries: [
        {
          key: 'pending:entry-1',
          target: { kind: 'pending', entryId: 'entry-1' },
          basic: { card: { name: 'Lightning Bolt' }, printing: { printingId: 'printing-1' } },
        },
        { key: 'pending:entry-2', basic: null },
      ],
    });
    // The provider record and the session its read reported stay available to the page reviewing
    // the entry, under the entry's own key.
    expect(binding.record('pending:entry-1')?.entry).toMatchObject({
      entryId: 'entry-1',
      revision: 4,
    });
    expect(binding.record('pending:entry-2')?.printing).toBeNull();
    expect(binding.keys()).toEqual(['pending:entry-1', 'pending:entry-2']);
    expect(binding.session()).toMatchObject({ sessionId: 'manual', revision: 3 });
    expect(
      binding.source.affects?.(
        { scope: 'imports', records: [], imports: ['other'], position: null },
        'manual',
      ),
    ).toBe(false);
  });

  it('reports an import continuation the provider invalidated instead of repeating it', async () => {
    const binding = pendingEntriesBinding({
      entries: {
        entries: () => Promise.reject(new SearchError('stale-continuation', 'The import changed.')),
      },
      catalog: { resolve: () => Promise.reject(new Error('No resolution.')) } as never,
    });
    await expect(
      binding.source.load({
        context: 'manual',
        pageSize: 50,
        continuation: 'cursor-1',
        signal: new AbortController().signal,
        required: { positions: [] },
      }),
    ).resolves.toEqual({ status: 'invalidated' });
  });

  it('translates one tag’s associations with their records, ownership and sequence reads', async () => {
    const progress = Promise.withResolvers<{ state: 'incorporated'; revisions: null }>();
    const binding = tagAssociationsBinding({
      search: {
        execute: () => Promise.reject(new Error('No query')),
        observe: () => progress.promise,
      },
      tagId: 'tag-wish',
      read: {
        constraints: { batch: { references: 50 } },
        associations: () =>
          Promise.resolve({
            privateRevision: 'private-1',
            associations: [
              {
                associationId: 'association-1',
                tagId: 'tag-wish',
                targetLevel: 'card',
                targetId: 'card-bolt',
                quantity: 4,
                revision: 2,
              },
            ],
            continuation: null,
          }) as never,
        readCopies: () => Promise.resolve({ copies: new Map(), missing: [] }) as never,
      } as never,
      catalog: {
        resolve: () =>
          Promise.resolve({
            revision: {
              revisionId: 'r',
              sourceName: 'fixture',
              sourceVersion: '1',
              publishedAt: '',
            },
            cards: new Map([['card-bolt', { cardId: 'card-bolt', name: 'Lightning Bolt' }]]),
            printings: new Map(),
            missing: [],
          }) as never,
      } as never,
      counts: {
        ofBatch: (targets, tagId) =>
          Promise.resolve(
            new Map(
              targets.map((target) => [
                cardListEntryKey(target),
                { owned: 1, locations: 1, intended: tagId === 'tag-wish' ? 4 : null },
              ]),
            ),
          ),
      },
    });

    const page = await binding.source.load({
      context: 'tag-wish',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
      required: { positions: [] },
    });
    expect(page).toMatchObject({
      status: 'page',
      current: true,
      entries: [
        {
          key: 'association:association-1',
          target: { kind: 'card', cardId: 'card-bolt' },
          basic: { card: { name: 'Lightning Bolt' } },
        },
      ],
    });
    expect(binding.record('association:association-1')).toMatchObject({
      associationId: 'association-1',
      quantity: 4,
    });

    const request = {
      context: 'tag-wish',
      pageSize: 50,
      continuation: null,
      signal: new AbortController().signal,
      required: { positions: ['20'] },
    };
    const observing = binding.source.observe!({ positions: ['20'], signal: request.signal });
    // Private membership is usable even while Search cannot yet answer the progress read.
    await expect(binding.source.load(request)).resolves.toMatchObject({
      current: false,
      entries: [{ key: 'association:association-1' }],
    });
    progress.resolve({ state: 'incorporated', revisions: null });
    await observing;
    await expect(binding.source.load(request)).resolves.toMatchObject({ current: true });

    // The ownership fragment reads the association's own typed target and the presented tag's
    // intended quantity, so a copy-level association is not mistaken for a card.
    const ownership = await binding.ownership.read({
      keys: ['association:association-1'],
      information: ['ownership'],
      signal: new AbortController().signal,
    });
    expect(ownership).toEqual([
      {
        key: 'association:association-1',
        status: 'ready',
        values: { owned: 1, locations: 1, intended: 4 },
      },
    ]);
  });
});

describe('bounded, account-isolated recent card activity', () => {
  it('honors the requested page bound and continues the recorded history', async () => {
    const recent = createRecentActivity();
    for (const index of [1, 2, 3]) {
      recent.record('alice', listEntry(`card:${index}`, String(index)));
    }
    const source = recent.source('alice');
    const load = (continuation: string | null, pageSize: number) =>
      source.load({
        context: 'alice',
        pageSize,
        continuation,
        signal: new AbortController().signal,
        required: { positions: [] },
      });

    // The recorded history is one bounded sequence like every other source: a page holds at most
    // the requested entries and names the continuation of the rest.
    const page = await load(null, 2);
    expect(page).toMatchObject({
      status: 'page',
      entries: [{ key: 'card:3' }, { key: 'card:2' }],
      current: true,
    });
    const continuation = page.status === 'page' ? page.continuation : null;
    expect(continuation).not.toBeNull();
    await expect(load(continuation, 2)).resolves.toMatchObject({
      status: 'page',
      entries: [{ key: 'card:1' }],
      continuation: null,
    });
    await expect(load(null, CARD_LIST_LIMITS.page)).resolves.toMatchObject({
      entries: [{ key: 'card:3' }, { key: 'card:2' }, { key: 'card:1' }],
      continuation: null,
    });
  });

  it('presents the most recent entry first and keeps one entry per card', () => {
    const recent = createRecentActivity();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('alice', listEntry('card:2', '2'));
    recent.record('alice', listEntry('card:1', '1'));

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:1', 'card:2']);
  });

  it('bounds the entries of one account', () => {
    const recent = createRecentActivity(2);
    for (const index of [1, 2, 3]) {
      recent.record('alice', listEntry(`card:${index}`, String(index)));
    }

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:3', 'card:2']);
  });

  it('never presents one account’s activity to another and forgets the account it is told to', () => {
    const recent = createRecentActivity();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('bob', listEntry('card:2', '2'));

    expect(recent.entries('bob').map((kept) => kept.key)).toEqual(['card:2']);
    recent.clear('alice');
    expect(recent.entries('alice')).toEqual([]);
    expect(recent.entries('bob')).toHaveLength(1);
  });

  it('records no entry without resolved card information and keeps its bound finite', () => {
    const recent = createRecentActivity();
    recent.record('alice', {
      key: 'copy:unresolved',
      target: { kind: 'copy', copyId: 'unresolved' },
      basic: null,
      quantity: null,
    });

    expect(recent.entries('alice')).toEqual([]);
    expect(() => recent.record('', listEntry('card:1', '1'))).toThrow(TypeError);
    expect(() => createRecentActivity(0)).toThrow(TypeError);
  });
});
