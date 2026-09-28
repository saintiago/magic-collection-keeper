/**
 * Component scope: the browsing pages of the UserInterface
 * (docs/user-interface.md#pages-and-navigation, docs/user-interface.md#browsing-and-organization,
 * docs/search.md#scryfall-compatibility).
 *
 * The catalog route vocabulary and the controls the page presents are asserted here; the Search
 * binding its list reads through is exercised in tests/component/card-list/bindings.test.ts, and
 * the pages themselves as observable browser behavior in tests/browser/browse.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import { finishes } from '../../../src/catalog/index.js';
import { searchResultLevels } from '../../../src/search/index.js';
import {
  UI_LIMITS,
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiView,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiHref,
} from '../../../src/ui/index.js';

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
