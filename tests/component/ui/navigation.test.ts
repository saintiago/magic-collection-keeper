/**
 * Component scope: the UserInterface navigation contract (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation).
 *
 * The routes present every dedicated page, keep the three card specificity levels and name no
 * other view; the restoration store keeps bounded state for one account at a time. Page
 * implementations, identity transitions and history behavior are exercised as observable browser
 * behavior in tests/browser/ui-shell.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG_LIMITS } from '../../../src/catalog/index.js';
import { SEARCH_LIMITS } from '../../../src/search/index.js';
import { USERCARDS_LIMITS } from '../../../src/usercards/index.js';
import {
  createViewStateStore,
  createUserInterface,
  readUiView,
  uiHref,
  UI_LIMITS,
  type UiRetainedRelease,
  type UserInterfaceOptions,
  type UiView,
  type UiViewSnapshot,
} from '../../../src/ui/index.js';

/** Release callback of a page that retains plain values: releasing them frees nothing. */
const releaseNothing: UiRetainedRelease = () => {};

const views: readonly UiView[] = [
  { page: 'home' },
  { page: 'catalog', query: '', level: 'card', owned: false, finish: null },
  {
    page: 'catalog',
    query: 'set:blb cn:1 "lightning bolt"',
    level: 'printing',
    owned: true,
    finish: 'foil',
  },
  { page: 'collection', query: '', level: 'card' },
  { page: 'collection', query: 'set:blb', level: 'copy' },
  { page: 'tags' },
  { page: 'tag', tagId: 'tag-1' },
  { page: 'card', cardId: 'card-1', printingId: null, copyId: null },
  { page: 'card', cardId: 'card-1', printingId: 'printing-1', copyId: null },
  { page: 'card', cardId: 'card-1', printingId: 'printing-1', copyId: 'copy-1' },
  { page: 'import' },
];

describe('dedicated page routes', () => {
  it.each(views)('round trips the $page view through its href', (view) => {
    expect(readUiView(uiHref(view))).toEqual(view);
  });

  it.each(views)('reads the $page view from a full URL', (view) => {
    expect(readUiView(`https://keeper.test/${uiHref(view)}`)).toEqual(view);
    expect(readUiView(new URL(`https://keeper.test/${uiHref(view)}`))).toEqual(view);
  });

  it('presents Home for the root URL and the bare fragment', () => {
    expect(readUiView('https://keeper.test/')).toEqual({ page: 'home' });
    expect(readUiView('https://keeper.test/#')).toEqual({ page: 'home' });
    expect(readUiView('#/')).toEqual({ page: 'home' });
  });

  it.each([
    '#/unknown',
    '#/cards',
    '#/cards/card-1/printing-1/copy-1/extra',
    '#/cards/card-1//copy-1',
    '#/tags/',
    '#//cards',
    '#notes',
    '#/cards/%',
  ])('presents nothing for %s', (href) => {
    expect(readUiView(href)).toBeNull();
  });

  it.each([' ', '\t\n\u00a0', 'a b', ' padded '])(
    'preserves the opaque identity %j in every route position',
    (identity) => {
      const identityViews: readonly UiView[] = [
        { page: 'tag', tagId: identity },
        { page: 'card', cardId: identity, printingId: null, copyId: null },
        { page: 'card', cardId: 'card', printingId: identity, copyId: null },
        { page: 'card', cardId: 'card', printingId: 'printing', copyId: identity },
      ];
      for (const view of identityViews) {
        const href = uiHref(view);
        expect(readUiView(href)).toEqual(view);
        expect(readUiView(new URL(`https://keeper.test/${href}`))).toEqual(view);
      }
    },
  );

  it('rejects a route segment outside the declared bounds', () => {
    const overLong = 'x'.repeat(UI_LIMITS.routeSegment + 1);
    expect(readUiView(`#/tags/${overLong}`)).toBeNull();
    expect(readUiView(`#/tags/${'x'.repeat(UI_LIMITS.routeSegment)}`)).toEqual({
      page: 'tag',
      tagId: 'x'.repeat(UI_LIMITS.routeSegment),
    });
    expect(() => uiHref({ page: 'tag', tagId: overLong })).toThrow(TypeError);
    expect(() => uiHref({ page: 'tag', tagId: '' })).toThrow(TypeError);
  });

  it('carries the longest identity the components a route names publish', () => {
    expect(UI_LIMITS.routeSegment).toBeGreaterThanOrEqual(
      Math.max(
        CATALOG_LIMITS.maxIdentifierLength,
        SEARCH_LIMITS.maxIdentifierLength,
        USERCARDS_LIMITS.maxIdentifierLength,
      ),
    );

    // Every identity a provider can publish is linked and read back, card and printing alike.
    const longestCardId = 'c'.repeat(CATALOG_LIMITS.maxIdentifierLength);
    const longestPrintingId = 'p'.repeat(CATALOG_LIMITS.maxIdentifierLength);
    expect(
      readUiView(
        uiHref({
          page: 'card',
          cardId: longestCardId,
          printingId: longestPrintingId,
          copyId: null,
        }),
      ),
    ).toEqual({
      page: 'card',
      cardId: longestCardId,
      printingId: longestPrintingId,
      copyId: null,
    });
  });

  it('encodes an identity that contains route characters', () => {
    const view: UiView = { page: 'tag', tagId: 'a/b?c#d e' };
    const href = uiHref(view);
    expect(href).not.toContain(' ');
    expect(readUiView(href)).toEqual(view);
  });

  it('refuses a copy level that names no printing', () => {
    expect(() =>
      uiHref({ page: 'card', cardId: 'card-1', printingId: null, copyId: 'copy-1' }),
    ).toThrow(TypeError);
  });
});

describe('opaque, account-isolated restoration state', () => {
  function snapshot(state: unknown, overrides: Partial<UiViewSnapshot> = {}): UiViewSnapshot {
    return { state, scrollY: 0, focusId: null, ...overrides };
  }

  it('keeps one view state per account and token', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save(
      'account-a',
      token,
      snapshot(
        { query: 'bolt', selection: ['card:1', 'copy:2'], filtered: true },
        {
          scrollY: 240,
          focusId: 'search-input',
        },
      ),
      releaseNothing,
    );

    expect(store.read('account-a', token)).toEqual({
      state: { query: 'bolt', selection: ['card:1', 'copy:2'], filtered: true },
      scrollY: 240,
      focusId: 'search-input',
    });
    expect(store.size).toBe(1);
  });

  it('never restores a snapshot for another account', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot({ query: 'bolt' }), releaseNothing);

    expect(store.read('account-b', token)).toBeNull();
    expect(store.read('account-a', 'unknown-token')).toBeNull();
  });

  it('replaces the state of one entry when the entry is left again', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot({ query: 'initial' }), releaseNothing);
    store.save('account-a', token, snapshot({ query: 'latest', bolt: true }), releaseNothing);

    expect(store.size).toBe(1);
    expect(store.read('account-a', token)?.state).toEqual({ query: 'latest', bolt: true });
  });

  it('mints tokens that never collide with another store lifetime', () => {
    const surviving = createViewStateStore();
    const reloaded = createViewStateStore();
    const survivingToken = surviving.open();

    expect(reloaded.open()).not.toBe(survivingToken);
    expect(surviving.owns(survivingToken)).toBe(true);
    expect(reloaded.owns(survivingToken)).toBe(false);
    reloaded.save('account-a', survivingToken, snapshot({ query: 'after reload' }), releaseNothing);

    expect(reloaded.read('account-a', survivingToken)).toBeNull();
  });

  it('keeps the state a page supplies as it is, without a storage bound of its own', () => {
    const store = createViewStateStore();
    const token = store.open();
    // A selection far beyond a hundred identities, a long draft and a nested representation the
    // page owns: history storage never becomes a selection limit and never drops the state.
    const state = {
      selection: Array.from({ length: 500 }, (_, index) => `copy:${index}`),
      draft: 'x'.repeat(4000),
      position: { continuation: 'cursor-1', offset: 12 },
      nested: { lists: [{ window: 500 }] },
    };
    store.save('account-a', token, snapshot(state), releaseNothing);

    expect(store.read('account-a', token)?.state).toBe(state);
  });

  it.each([null, undefined])('preserves opaque nullish page state: %s', (state) => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot(state), releaseNothing);

    expect(store.read('account-a', token)).not.toBeNull();
    expect(store.read('account-a', token)?.state).toBe(state);
  });

  it('sanitizes only the presentation state the shell owns', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save(
      'account-a',
      token,
      {
        state: { anything: true },
        scrollY: Number.POSITIVE_INFINITY,
        focusId: 42 as never,
        anchorId: 'result-1',
        anchorTop: Number.NaN,
      },
      releaseNothing,
    );

    expect(store.read('account-a', token)).toEqual({
      state: { anything: true },
      scrollY: 0,
      focusId: null,
      anchorId: 'result-1',
      anchorTop: 0,
    });
  });

  it('evicts the oldest snapshot beyond the declared bound', () => {
    const store = createViewStateStore(3);
    const tokens = ['first', 'second', 'third', 'fourth'].map((value) => {
      const token = store.open();
      store.save(
        'account-a',
        token,
        snapshot({ query: value, selection: ['copy:1'] }),
        releaseNothing,
      );
      return token;
    });

    expect(store.size).toBe(3);
    expect(store.read('account-a', tokens[0] ?? '')).toBeNull();
    expect(store.read('account-a', tokens[3] ?? '')?.state).toEqual({
      query: 'fourth',
      selection: ['copy:1'],
    });
  });

  it('keeps the declared bound positive and finite', () => {
    expect(UI_LIMITS.viewStates).toBeGreaterThan(0);
    expect(() => createViewStateStore(0)).toThrow(TypeError);
    expect(() => createViewStateStore(Number.NaN)).toThrow(TypeError);
  });

  it('clears every snapshot when the session ends', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot({ query: 'bolt' }), releaseNothing);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.read('account-a', token)).toBeNull();
  });

  it('releases a retained handle through its owning factory when the entry is replaced', () => {
    const store = createViewStateStore();
    const token = store.open();
    const released: unknown[] = [];
    const first = { resource: 'handle-1' };
    const latest = { resource: 'handle-2' };
    store.save('account-a', token, snapshot(first), (retained) => released.push(retained));
    // The page hands back the very same handle: it still owns it, so nothing is released.
    store.save('account-a', token, snapshot(first), (retained) => released.push(retained));
    expect(released).toEqual([]);

    store.save('account-a', token, snapshot(latest), (retained) => released.push(retained));
    expect(released).toEqual([first]);
    expect(store.read('account-a', token)?.state).toBe(latest);
  });

  it('releases the retained handles of the evicted entries when the bound drops one', () => {
    const store = createViewStateStore(2);
    const released: unknown[] = [];
    for (const value of ['first', 'second', 'third']) {
      const token = store.open();
      store.save('account-a', token, snapshot(value), (retained) => released.push(retained));
    }

    expect(store.size).toBe(2);
    expect(released).toEqual(['first']);
  });

  it('releases every retained handle when the presented account ends', () => {
    const store = createViewStateStore();
    const released: unknown[] = [];
    const tokens = ['one', 'two'].map((value) => {
      const token = store.open();
      store.save('account-a', token, snapshot(value), (retained) => released.push(retained));
      return token;
    });

    store.clear();

    expect(released).toEqual(['one', 'two']);
    expect(store.size).toBe(0);
    expect(store.read('account-a', tokens[0] ?? '')).toBeNull();
  });

  it('releases the handle of an entry the user cannot return to', () => {
    const store = createViewStateStore();
    const token = store.open();
    const released: unknown[] = [];
    store.save('account-a', token, snapshot('replaced'), (retained) => released.push(retained));

    store.discard(token);

    expect(released).toEqual(['replaced']);
    expect(store.read('account-a', token)).toBeNull();
    // Discarding a token this store never kept releases nothing.
    store.discard(store.open());
    expect(released).toEqual(['replaced']);
  });

  it('keeps navigating when a factory fails to release one handle', () => {
    const store = createViewStateStore(1);
    const released: unknown[] = [];
    const first = store.open();
    store.save('account-a', first, snapshot('first'), () => {
      throw new Error('The resource was already gone.');
    });
    const second = store.open();
    store.save('account-a', second, snapshot('second'), (retained) => released.push(retained));

    expect(store.size).toBe(1);
    expect(store.read('account-a', second)?.state).toBe('second');
    store.clear();
    expect(released).toEqual(['second']);
  });
});

describe('shell construction', () => {
  it('rejects construction without the boundaries it presents', () => {
    expect(() => createUserInterface({} as unknown as UserInterfaceOptions)).toThrow(TypeError);
    const root = { ownerDocument: { defaultView: null } } as unknown as Element;
    expect(() => createUserInterface({ root } as unknown as UserInterfaceOptions)).toThrow(
      TypeError,
    );
  });
});
