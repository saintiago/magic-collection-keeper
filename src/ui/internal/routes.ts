/**
 * Routes of the UserInterface (docs/user-interface.md#pages-and-navigation).
 *
 * Home, catalog/search, collection, tags, tag views, card details and import are dedicated pages.
 * A view is identified by the URL fragment, so a reload or a direct entry presents the same view
 * and card details keep their three specificity levels: card, printing and physical copy. The
 * fragment is used instead of the path so a static deployment serves every view without server
 * rewrites.
 */

import { UI_LIMITS } from './limits.js';

export const uiPageNames = [
  'home',
  'catalog',
  'collection',
  'tags',
  'tag',
  'card',
  'import',
] as const;

/** One dedicated page of the UserInterface. */
export type UiPageName = (typeof uiPageNames)[number];

/**
 * One presented view. `printingId` and `copyId` are null above their level, and a copy-level view
 * always names its printing.
 */
export type UiView =
  | { readonly page: 'home' }
  | { readonly page: 'catalog'; readonly query: string }
  | { readonly page: 'collection' }
  | { readonly page: 'tags' }
  | { readonly page: 'tag'; readonly tagId: string }
  | {
      readonly page: 'card';
      readonly cardId: string;
      readonly printingId: string | null;
      readonly copyId: string | null;
    }
  | { readonly page: 'import' };

/** Fragment prefix of every UserInterface route. */
export const UI_ROUTE_PREFIX = '#/';

/** Relative href of one view, safe to use as a link target. */
export function uiHref(view: UiView): string {
  switch (view.page) {
    case 'home':
      return UI_ROUTE_PREFIX;
    case 'catalog': {
      const query = new URLSearchParams();
      if (view.query.length > 0) {
        query.set('query', view.query);
      }
      const text = query.toString();
      return text === '' ? `${UI_ROUTE_PREFIX}catalog` : `${UI_ROUTE_PREFIX}catalog?${text}`;
    }
    case 'collection':
      return `${UI_ROUTE_PREFIX}collection`;
    case 'tags':
      return `${UI_ROUTE_PREFIX}tags`;
    case 'tag':
      return `${UI_ROUTE_PREFIX}tags/${routeSegment(view.tagId)}`;
    case 'card': {
      const segments = [routeSegment(view.cardId)];
      if (view.printingId !== null) {
        segments.push(routeSegment(view.printingId));
      }
      if (view.copyId !== null) {
        if (view.printingId === null) {
          throw new TypeError('A copy-level card view names the printing the copy belongs to.');
        }
        segments.push(routeSegment(view.copyId));
      }
      return `${UI_ROUTE_PREFIX}cards/${segments.join('/')}`;
    }
    case 'import':
      return `${UI_ROUTE_PREFIX}import`;
  }
}

/**
 * View one URL presents, or null when the URL is not a UserInterface route. The root URL and `#/`
 * present Home, so a direct entry without a fragment is the home page instead of a missing page.
 */
export function readUiView(url: string | URL): UiView | null {
  const fragment = readFragment(url);
  if (fragment === null) {
    return null;
  }
  const [path, search] = splitSearch(fragment);
  const route = path.slice(1);
  if (route === '') {
    return { page: 'home' };
  }
  const segments = readSegments(route.split('/'));
  return segments === null ? null : readView(segments, search);
}

/** Heading text of one view. */
export function uiViewTitle(view: UiView): string {
  switch (view.page) {
    case 'home':
      return 'Home';
    case 'catalog':
      return 'Catalog and search';
    case 'collection':
      return 'Collection';
    case 'tags':
      return 'Tags';
    case 'tag':
      return 'Tag';
    case 'card':
      return 'Card details';
    case 'import':
      return 'Import';
  }
}

function readView(segments: readonly string[], search: string): UiView | null {
  const [head] = segments;
  if (head === 'catalog' && segments.length === 1) {
    return { page: 'catalog', query: new URLSearchParams(search).get('query') ?? '' };
  }
  if (head === 'collection' && segments.length === 1) {
    return { page: 'collection' };
  }
  if (head === 'import' && segments.length === 1) {
    return { page: 'import' };
  }
  if (head === 'tags') {
    if (segments.length === 1) {
      return { page: 'tags' };
    }
    const tagId = segments[1];
    return segments.length === 2 && tagId !== undefined ? { page: 'tag', tagId } : null;
  }
  if (head === 'cards' && segments.length >= 2 && segments.length <= 4) {
    const cardId = segments[1];
    if (cardId !== undefined) {
      return {
        page: 'card',
        cardId,
        printingId: segments[2] ?? null,
        copyId: segments[3] ?? null,
      };
    }
  }
  return null;
}

/** Fragment of one URL, or null when it is not a route fragment. */
function readFragment(url: string | URL): string | null {
  const text = typeof url === 'string' ? url : url.href;
  const index = text.indexOf('#');
  const fragment = index === -1 ? '' : text.slice(index + 1);
  if (fragment === '') {
    return '/';
  }
  return fragment.startsWith('/') ? fragment : null;
}

/** One fragment split into its route path and query text. */
function splitSearch(fragment: string): readonly [string, string] {
  const index = fragment.indexOf('?');
  return index === -1 ? [fragment, ''] : [fragment.slice(0, index), fragment.slice(index + 1)];
}

/** Decoded route segments, or null when one of them is empty or outside the bounds. */
function readSegments(values: readonly string[]): readonly string[] | null {
  const segments: string[] = [];
  for (const value of values) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    if (decoded.trim().length === 0 || decoded.length > UI_LIMITS.routeSegment) {
      return null;
    }
    segments.push(decoded);
  }
  return segments;
}

/** One encoded route segment; an empty or over-long identity is rejected instead of linked. */
function routeSegment(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > UI_LIMITS.routeSegment) {
    throw new TypeError('A UserInterface route segment names a bounded identity.');
  }
  return encodeURIComponent(value);
}
