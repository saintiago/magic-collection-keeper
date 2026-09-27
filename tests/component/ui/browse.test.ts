/**
 * Component scope: the browsing pages of the UserInterface
 * (docs/user-interface.md#pages-and-navigation, docs/user-interface.md#browsing-and-organization,
 * docs/search.md#scryfall-compatibility).
 *
 * The catalog control vocabulary, the Search request the page builds, the entries its list
 * presents and the bounded recent card activity are asserted here; the pages themselves are
 * exercised as observable browser behavior in tests/browser/browse.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import { finishes } from '../../../src/catalog/index.js';
import {
  SearchError,
  normalizeSearchRequest,
  searchEntryKey,
  searchResultLevels,
} from '../../../src/search/index.js';
import {
  UI_LIMITS,
  catalogSearchRequest,
  createCatalogSearchAccess,
  createEntryOwnershipReader,
  createRecentCards,
  createSearchCounts,
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiView,
  searchListEntry,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiEntryKey,
  uiHref,
  type UiCatalogQuery,
  type UiListEntry,
} from '../../../src/ui/index.js';

const caller = { accountId: 'browse-account' };

/** One catalog query with the controls a browsing page presents. */
function query(overrides: Partial<UiCatalogQuery> = {}): UiCatalogQuery {
  return {
    text: '',
    level: 'card',
    owned: false,
    finish: null,
    ...overrides,
  };
}

/** One search entry as the Search contract returns it. */
function entry(): Parameters<typeof searchListEntry>[0] {
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
function listEntry(key: string, cardId: string): UiListEntry {
  return {
    key,
    target: { kind: 'card', cardId },
    basic: { card: { cardId, name: 'Lightning Bolt', matchedName: null }, printing: null },
    quantity: null,
  };
}

describe('catalog control vocabulary', () => {
  it('presents the card and printing levels Search evaluates and the finishes Catalog publishes', () => {
    expect([...uiCatalogLevels]).toEqual(searchResultLevels.filter((level) => level !== 'copy'));
    expect([...uiCatalogFinishes]).toEqual([...finishes]);
  });

  it('reads a control value, falling back to the whole-catalog defaults', () => {
    expect(readUiCatalogLevel('printing')).toBe('printing');
    expect(readUiCatalogLevel('copy')).toBe('card');
    expect(readUiCatalogLevel(null)).toBe('card');
    expect(readUiCatalogFinish('foil')).toBe('foil');
    expect(readUiCatalogFinish('unknown')).toBeNull();
    expect(readUiCatalogFinish(null)).toBeNull();
  });
});

describe('catalog view URLs', () => {
  it('carries the whole query of the presented result', () => {
    const view = {
      page: 'catalog',
      query: 'bolt',
      level: 'printing',
      owned: true,
      finish: 'foil',
    } as const;

    expect(uiHref(view)).toBe('#/catalog?query=bolt&level=printing&owned=1&finish=foil');
    expect(readUiView(uiHref(view))).toEqual(view);
  });

  it('keeps a control-free query and the defaults short', () => {
    expect(uiHref({ page: 'catalog', query: '', level: 'card', owned: false, finish: null })).toBe(
      '#/catalog',
    );
    expect(readUiView('#/catalog')).toEqual({
      page: 'catalog',
      query: '',
      level: 'card',
      owned: false,
      finish: null,
    });
  });

  it('rejects an expression outside the state the page bounds', () => {
    const text = 'x'.repeat(UI_LIMITS.catalogQuery + 1);

    expect(readUiView(`#/catalog?query=${text}`)).toBeNull();
    expect(() =>
      uiHref({ page: 'catalog', query: text, level: 'card', owned: false, finish: null }),
    ).toThrow(TypeError);
  });
});

describe('catalog search requests', () => {
  it('sends the text expression, the result level and the page boundary', () => {
    expect(
      catalogSearchRequest(query({ text: ' bolt ', level: 'printing' }), 25, 'cursor-1'),
    ).toEqual({
      resultLevel: 'printing',
      query: 'bolt',
      pageSize: 25,
      continuation: 'cursor-1',
    });
    expect(catalogSearchRequest(query(), 50, null)).toEqual({ resultLevel: 'card', pageSize: 50 });
  });

  it('turns the structured controls into the same criteria as their text expressions', () => {
    const controls = normalizeSearchRequest(
      catalogSearchRequest(query({ owned: true, finish: 'foil' }), 50, null),
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
      normalizeSearchRequest(catalogSearchRequest(query({ owned: true }), 50, null), null),
    ).toThrowError(expect.objectContaining({ code: 'unauthorized' }));
  });
});

describe('catalog list entries', () => {
  it('presents the provider key, target, basic information and quantities', () => {
    expect(searchListEntry(entry())).toEqual({
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
      expect(uiEntryKey(target)).toBe(searchEntryKey(target));
    }
  });

  it('validates the contracts it reads through', () => {
    expect(() => createCatalogSearchAccess(undefined as never, {} as never)).toThrow(TypeError);
    expect(() =>
      createCatalogSearchAccess(
        {
          execute: () => Promise.resolve({}) as never,
          counts: () => Promise.resolve({}) as never,
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
    const access = createSearchCounts({
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
    const access = createSearchCounts({
      execute: () => Promise.reject(new Error('The counts read runs no query.')),
      counts: () => Promise.reject(new Error('The service is down.')),
    } as never);

    await expect(
      access.ofBatch([{ kind: 'card', cardId: 'card-1' }], null, new AbortController().signal),
    ).rejects.toThrow('The service is down.');
  });

  it('presents the owned and location counts of the entries a fragment names', async () => {
    const access = createSearchCounts({
      execute: () => Promise.reject(new Error('The counts read runs no query.')),
      counts: (request: {
        readonly references: readonly { readonly kind: 'card' | 'printing' | 'copy' }[];
      }) => Promise.resolve(counts(request.references)),
    } as never);
    const reader = createEntryOwnershipReader(access);

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

describe('bounded, account-isolated recent card activity', () => {
  it('presents the most recent entry first and keeps one entry per card', () => {
    const recent = createRecentCards();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('alice', listEntry('card:2', '2'));
    recent.record('alice', listEntry('card:1', '1'));

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:1', 'card:2']);
  });

  it('bounds the entries of one account', () => {
    const recent = createRecentCards(2);
    for (const index of [1, 2, 3]) {
      recent.record('alice', listEntry(`card:${index}`, String(index)));
    }

    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:3', 'card:2']);
  });

  it('never presents one account’s activity to another and forgets the account it is told to', () => {
    const recent = createRecentCards();
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('bob', listEntry('card:2', '2'));

    expect(recent.entries('bob').map((kept) => kept.key)).toEqual(['card:2']);
    recent.clear('alice');
    expect(recent.entries('alice')).toEqual([]);
    expect(recent.entries('bob')).toHaveLength(1);
  });

  it('records no entry without resolved card information and keeps its bound finite', () => {
    const recent = createRecentCards();
    recent.record('alice', {
      key: 'copy:unresolved',
      target: { kind: 'copy', copyId: 'unresolved' },
      basic: null,
      quantity: null,
    });

    expect(recent.entries('alice')).toEqual([]);
    expect(() => recent.record('', listEntry('card:1', '1'))).toThrow(TypeError);
    expect(() => createRecentCards(0)).toThrow(TypeError);
  });
});
