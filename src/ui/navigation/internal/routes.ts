/**
 * Routes of the UserInterface (docs/ui/navigation.md).
 *
 * Home, catalog/search, collection, tags, tag views, card details and import are dedicated pages.
 * A view is identified by the URL fragment, so a reload or a direct entry presents the same view
 * and card details keep their three specificity levels: card, printing and physical copy. The
 * fragment is used instead of the path so a static deployment serves every view without server
 * rewrites.
 *
 * A catalog view names its public text expression, result level and finish. A collection view
 * names its private result level and optional card identity. These URL values reproduce the
 * corresponding owner query on reload (docs/ui/pages.md#page-map).
 */

// Type-only imports keep the provider barrels out of a browser bundle: a value import would pull
// the whole Catalog module, including its Node-only synchronization job, into the page.
import type { Finish } from '../../../catalog/index.js';
import {
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiCollectionLevel,
  type UiCatalogLevel,
  type UiCollectionLevel,
} from '../../shared/vocabulary.js';
import { UI_LIMITS } from '../../shared/limits.js';

export {
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiCollectionLevel,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiCollectionLevels,
  uiFinishLabel,
  type UiCatalogLevel,
  type UiCollectionLevel,
} from '../../shared/vocabulary.js';

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
  | {
      readonly page: 'catalog';
      /** Text expression of the query; empty browses the whole catalog. */
      readonly query: string;
      readonly level: UiCatalogLevel;
      /** Whether the query requires the account to own the entry. */
      readonly owned: boolean;
      /** Required printing finish, or null when the query does not constrain it. */
      readonly finish: Finish | null;
    }
  | {
      readonly page: 'collection';
      readonly cardId?: string;
      /** Text expression of the query; empty presents every owned entry of the level. */
      readonly query: string;
      readonly level: UiCollectionLevel;
    }
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
      if (view.query.length > UI_LIMITS.catalogQuery) {
        // A query outside the state a browsing page bounds is rejected instead of linked, as an
        // over-long route segment is.
        throw new TypeError('A catalog query is bounded by the state the page retains.');
      }
      const query = new URLSearchParams();
      if (view.query.length > 0) {
        query.set('query', view.query);
      }
      if (view.level !== 'card') {
        query.set('level', view.level);
      }
      if (view.owned) {
        query.set('owned', '1');
      }
      if (view.finish !== null) {
        query.set('finish', view.finish);
      }
      const text = query.toString();
      return text === '' ? `${UI_ROUTE_PREFIX}catalog` : `${UI_ROUTE_PREFIX}catalog?${text}`;
    }
    case 'collection': {
      if (view.query.length > UI_LIMITS.catalogQuery) {
        throw new TypeError('A collection query is bounded by the state the page retains.');
      }
      const query = new URLSearchParams();
      if (view.query.length > 0) {
        query.set('query', view.query);
      }
      if (view.level !== 'card') {
        query.set('level', view.level);
      }
      if (view.cardId !== undefined)
        query.set('cardId', decodeURIComponent(routeSegment(view.cardId)));
      const text = query.toString();
      return text === '' ? `${UI_ROUTE_PREFIX}collection` : `${UI_ROUTE_PREFIX}collection?${text}`;
    }
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
    const parameters = new URLSearchParams(search);
    const query = readQueryText(parameters.get('query'));
    if (query === null) {
      return null;
    }
    return {
      page: 'catalog',
      query,
      level: readUiCatalogLevel(parameters.get('level')),
      owned: parameters.get('owned') === '1',
      finish: readUiCatalogFinish(parameters.get('finish')),
    };
  }
  if (head === 'collection' && segments.length === 1) {
    const parameters = new URLSearchParams(search);
    const query = readQueryText(parameters.get('query'));
    const cardId = parameters.get('cardId');
    if (cardId !== null && (cardId.length === 0 || cardId.length > UI_LIMITS.routeSegment))
      return null;
    if (query === null) {
      return null;
    }
    return {
      page: 'collection',
      ...(cardId === null ? {} : { cardId }),
      query,
      level: readUiCollectionLevel(parameters.get('level')),
    };
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

/** Text expression one browsing URL names, or null when it is outside the declared bound. */
function readQueryText(value: string | null): string | null {
  const text = value ?? '';
  return text.length <= UI_LIMITS.catalogQuery ? text : null;
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
    // Provider identities are opaque: whitespace is significant, just as it is in routeSegment.
    if (decoded.length === 0 || decoded.length > UI_LIMITS.routeSegment) {
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
