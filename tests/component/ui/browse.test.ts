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
import { normalizeSearchRequest, searchResultLevels } from '../../../src/search/index.js';
import {
  UI_LIMITS,
  catalogSearchRequest,
  createCatalogSearchAccess,
  createRecentCards,
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

const catalogEditions = finishes;

const caller = { accountId: 'browse-account' };

/** One catalog query with the controls a browse page presents. */
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
  it('presents the levels and finishes the providers publish', () => {
    expect([...uiCatalogLevels]).toEqual(searchResultLevels.filter((level) => level !== 'copy'));
    expect([...uiCatalogFinishes]).toEqual([...catalogEditions]);
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

  it('rejects an expression outside the state the shell keeps', () => {
    const text = 'x'.repeat(UI_LIMITS.restorationText + 1);

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
    expect(uiEntryKey({ kind: 'card', cardId: 'card-1' })).toBe('card:card-1');
    expect(uiEntryKey({ kind: 'printing', printingId: 'printing-1' })).toBe('printing:printing-1');
    expect(uiEntryKey({ kind: 'copy', copyId: 'copy-1' })).toBe('copy:copy-1');
  });

  it('validates the contracts it reads through', () => {
    expect(() => createCatalogSearchAccess(undefined as never, {} as never)).toThrow(TypeError);
    expect(() =>
      createCatalogSearchAccess({ execute: () => Promise.resolve({}) as never }, {} as never),
    ).toThrow(TypeError);
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

  it('never presents one account’s activity to another', () => {
    const recent = createRecentCards();
    recent.record('alice', listEntry('card:1', '1'));

    expect(recent.entries('bob')).toEqual([]);
    recent.retain('bob');
    expect(recent.entries('alice')).toEqual([]);
    recent.clear('alice');
    expect(recent.entries('alice')).toEqual([]);
  });

  it('bounds the accounts it keeps and evicts the least recently active one', () => {
    const recent = createRecentCards(5, 2);
    recent.record('alice', listEntry('card:1', '1'));
    recent.record('bob', listEntry('card:2', '2'));
    recent.record('alice', listEntry('card:3', '3'));
    recent.record('carol', listEntry('card:4', '4'));

    expect(recent.entries('bob')).toEqual([]);
    expect(recent.entries('alice').map((kept) => kept.key)).toEqual(['card:3', 'card:1']);
    expect(recent.entries('carol').map((kept) => kept.key)).toEqual(['card:4']);
  });

  it('records no entry without resolved card information and keeps its bounds finite', () => {
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
    expect(() => createRecentCards(1, 0)).toThrow(TypeError);
  });
});
