/**
 * Component scope: the CardList presentation of the UserInterface
 * (docs/card-list.md#interface, docs/ui/architecture.md#state-ownership-and-restoration).
 *
 * The presentation renders the headless component's snapshots and reports user intent back
 * through its contract. The list behavior itself is exercised without a rendering dependency in
 * tests/component/card-list/card-list.test.ts, and the rendered journeys live in
 * tests/browser/card-list.spec.ts; this case keeps the presentation's default basic information
 * and its construction validation.
 */

import { describe, expect, it } from 'vitest';

import type { CardListEntry } from '../../../src/card-list/index.js';
import {
  cardListBasicContent,
  createCardListView,
  type UiCardListOptions,
} from '../../../src/ui/index.js';

/** One element of the minimal document the default rendering is asserted with. */
interface FakeElement {
  readonly dataset: Record<string, string>;
  readonly children: FakeElement[];
  textContent: string;
  append(...nodes: (FakeElement | string)[]): void;
}

function fakeDocument(): Document {
  const element = (): FakeElement => {
    const created: FakeElement = {
      dataset: {},
      children: [],
      textContent: '',
      append(...nodes) {
        created.children.push(
          ...(nodes.filter((node) => typeof node !== 'string') as FakeElement[]),
        );
      },
    };
    return created;
  };
  return { createElement: () => element() } as unknown as Document;
}

function entry(): CardListEntry {
  return {
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
    quantity: { copies: 2, intended: 1 },
  };
}

describe('default basic information', () => {
  it('renders the name, matched name, printing and both counts as text', () => {
    const content = cardListBasicContent(fakeDocument(), entry()) as unknown as FakeElement;

    expect(content.dataset.uiBasic).toBe('');
    expect(content.children.map((child) => child.textContent)).toEqual([
      'Lightning Bolt',
      ' (Blitzschlag)',
      ' M11 149 · en',
      ' Copies: 2',
      ' Intended: 1',
    ]);
  });

  it('names an unresolved entry instead of borrowing another card’s information', () => {
    const unresolved: CardListEntry = {
      key: 'copy:copy-1',
      target: { kind: 'copy', copyId: 'copy-1' },
      basic: null,
      quantity: null,
    };

    const content = cardListBasicContent(fakeDocument(), unresolved) as unknown as FakeElement;

    expect(content.children.map((child) => child.textContent)).toEqual(['Unresolved entry']);
  });
});

describe('CardList presentation construction', () => {
  it('requires the element the list renders into', () => {
    expect(() => createCardListView({} as unknown as UiCardListOptions<string>)).toThrow(TypeError);
    expect(() =>
      createCardListView({
        container: { ownerDocument: null } as unknown as HTMLElement,
      } as unknown as UiCardListOptions<string>),
    ).toThrow(TypeError);
  });

  it('requires a positive page size within the list bound', () => {
    const container = {
      ownerDocument: {},
      replaceChildren() {},
      append() {},
    } as unknown as HTMLElement;
    for (const pageSize of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createCardListView({
          container,
          pageSize,
        } as unknown as UiCardListOptions<string>),
      ).toThrow(TypeError);
    }
  });
});
