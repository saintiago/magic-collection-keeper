/**
 * Component scope: the CardList list boundary (docs/user-interface.md#list-boundary,
 * docs/user-interface.md#cardlist).
 *
 * The grouping of equivalent copies and the construction that validates the supplied boundaries
 * need no document; the asynchronous loading, fragment, tool and selection behavior is exercised
 * as observable browser behavior in tests/browser/card-list.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import {
  createCardList,
  groupCardListEntries,
  UI_LIMITS,
  type UiCardListOptions,
  type UiListEntry,
} from '../../../src/ui/index.js';

function copy(copyId: string, printingId: string): UiListEntry {
  return {
    key: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    basic: {
      card: { cardId: `card-${printingId}`, name: 'Lightning Bolt', matchedName: null },
      printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    },
    quantity: { copies: 1, intended: null },
  };
}

function card(cardId: string): UiListEntry {
  return {
    key: `card:${cardId}`,
    target: { kind: 'card', cardId },
    basic: {
      card: { cardId, name: 'Lightning Bolt', matchedName: null },
      printing: null,
    },
    quantity: null,
  };
}

function printing(printingId: string): UiListEntry {
  return {
    key: `printing:${printingId}`,
    target: { kind: 'printing', printingId },
    basic: {
      card: { cardId: `card-${printingId}`, name: 'Lightning Bolt', matchedName: null },
      printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    },
    quantity: null,
  };
}

function unresolved(copyId: string): UiListEntry {
  return {
    key: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    basic: null,
    quantity: null,
  };
}

/** A container that satisfies construction without a document, for the rejection cases. */
function placeholderContainer(): HTMLElement {
  return {
    ownerDocument: {},
    replaceChildren() {},
    append() {},
  } as unknown as HTMLElement;
}

function options(overrides: Partial<UiCardListOptions<string>>): UiCardListOptions<string> {
  return {
    container: placeholderContainer(),
    source: { load: () => Promise.resolve({ status: 'page', entries: [], continuation: null }) },
    context: 'result',
    pageSize: 2,
    ...overrides,
  };
}

describe('equivalent copy grouping', () => {
  it('groups consecutive copies of one printing and keeps their source order', () => {
    const entries = [
      copy('1', 'printing-1'),
      copy('2', 'printing-1'),
      copy('3', 'printing-2'),
      copy('4', 'printing-1'),
    ];

    const groups = groupCardListEntries(entries);

    expect(groups.map((group) => group.entries.map((entry) => entry.key))).toEqual([
      ['copy:1', 'copy:2'],
      ['copy:3'],
      ['copy:4'],
    ]);
    expect(groups.flatMap((group) => group.entries)).toEqual(entries);
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  });

  it('keeps cards, printings and unresolved copies outside a copy group', () => {
    const entries = [
      card('1'),
      printing('printing-1'),
      unresolved('2'),
      copy('3', 'printing-1'),
      copy('4', 'printing-1'),
    ];

    const groups = groupCardListEntries(entries);

    expect(groups.map((group) => group.entries.map((entry) => entry.key))).toEqual([
      ['card:1'],
      ['printing:printing-1'],
      ['copy:2'],
      ['copy:3', 'copy:4'],
    ]);
  });

  it('presents nothing for an empty window', () => {
    expect(groupCardListEntries([])).toEqual([]);
  });

  it('declares positive page, window, fragment batch and fragment item bounds', () => {
    expect(UI_LIMITS.listPage).toBeGreaterThan(0);
    expect(UI_LIMITS.listWindow).toBeGreaterThanOrEqual(UI_LIMITS.listPage);
    expect(UI_LIMITS.fragmentBatch).toBeGreaterThan(0);
    expect(UI_LIMITS.fragmentItems).toBeGreaterThan(0);
  });
});

describe('CardList construction', () => {
  it('rejects construction without the boundaries it presents', () => {
    expect(() => createCardList({} as unknown as UiCardListOptions)).toThrow(TypeError);
    expect(() => createCardList(options({ container: {} as HTMLElement }))).toThrow(TypeError);
    expect(() =>
      createCardList(options({ source: {} as UiCardListOptions<string>['source'] })),
    ).toThrow(TypeError);
  });

  it('rejects a page size outside the declared bound', () => {
    for (const pageSize of [0, -1, 1.5, Number.NaN, UI_LIMITS.listPage + 1]) {
      expect(() => createCardList(options({ pageSize }))).toThrow(TypeError);
    }
  });

  it('rejects fragment kinds and tools that do not read or invoke', () => {
    expect(() => createCardList(options({ fragments: { images: {} as never } }))).toThrow(
      TypeError,
    );
    expect(() =>
      createCardList(
        options({ tools: [{ id: 'wishlist', label: 'Wishlist', tool: {} as never }] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          tools: [
            { id: '', label: 'Wishlist', tool: { invoke: () => Promise.resolve(null as never) } },
          ],
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          tools: [
            {
              id: 'wishlist',
              label: 'Wishlist',
              tool: { invoke: () => Promise.resolve(null as never) },
            },
            {
              id: 'wishlist',
              label: 'Other',
              tool: { invoke: () => Promise.resolve(null as never) },
            },
          ],
        }),
      ),
    ).toThrow(TypeError);
  });

  it('rejects a cancellation signal that is not a signal', () => {
    expect(() => createCardList(options({ signal: {} as AbortSignal }))).toThrow(TypeError);
  });

  it('rejects a retained state it cannot interpret', () => {
    const position = { continuation: null, offset: 0 };
    const kept = { context: 'result', selectedTargets: [] };
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            position: null,
            selection: [],
            scrollTop: 0,
            focus: null,
          },
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 0,
            position,
            selection: [],
            scrollTop: 0,
            focus: null,
          },
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            // The offset names an entry inside the requested page, never beyond it.
            position: { continuation: null, offset: 2 },
            selection: [],
            scrollTop: 0,
            focus: null,
          },
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            position,
            selection: [42],
            scrollTop: 0,
            focus: null,
          } as never,
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            position,
            selection: [],
            scrollTop: -1,
            focus: null,
          },
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            position,
            selection: [],
            scrollTop: 0,
            focus: { control: 'unknown' } as never,
          },
        }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createCardList(
        options({
          restored: {
            ...kept,
            window: 1,
            position,
            selection: ['card:1'],
            selectedTargets: [{ key: 'card:1', target: { kind: 'copy' } } as never],
            scrollTop: 0,
            focus: null,
          },
        }),
      ),
    ).toThrow(TypeError);
  });
});
