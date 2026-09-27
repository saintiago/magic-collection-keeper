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

import {
  createViewStateStore,
  createUserInterface,
  readUiView,
  uiHref,
  UI_LIMITS,
  type UserInterfaceOptions,
  type UiView,
  type UiViewSnapshot,
} from '../../../src/ui/index.js';

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
  { page: 'collection' },
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
    '#/cards/%20',
    '#/tags/',
    '#//cards',
    '#notes',
    '#/cards/%',
  ])('presents nothing for %s', (href) => {
    expect(readUiView(href)).toBeNull();
  });

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
    store.save('account-a', token, snapshot({ query: 'bolt' }));

    expect(store.read('account-b', token)).toBeNull();
    expect(store.read('account-a', 'unknown-token')).toBeNull();
  });

  it('replaces the state of one entry when the entry is left again', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot({ query: 'initial' }));
    store.save('account-a', token, snapshot({ query: 'latest', bolt: true }));

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
    reloaded.save('account-a', survivingToken, snapshot({ query: 'after reload' }));

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
    store.save('account-a', token, snapshot(state));

    expect(store.read('account-a', token)?.state).toBe(state);
  });

  it.each([null, undefined])('preserves opaque nullish page state: %s', (state) => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, snapshot(state));

    expect(store.read('account-a', token)).not.toBeNull();
    expect(store.read('account-a', token)?.state).toBe(state);
  });

  it('sanitizes only the presentation state the shell owns', () => {
    const store = createViewStateStore();
    const token = store.open();
    store.save('account-a', token, {
      state: { anything: true },
      scrollY: Number.POSITIVE_INFINITY,
      focusId: 42 as never,
      anchorId: 'result-1',
      anchorTop: Number.NaN,
    });

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
      store.save('account-a', token, snapshot({ query: value, selection: ['copy:1'] }));
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
    store.save('account-a', token, snapshot({ query: 'bolt' }));

    store.clear();

    expect(store.size).toBe(0);
    expect(store.read('account-a', token)).toBeNull();
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
