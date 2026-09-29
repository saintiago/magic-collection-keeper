/**
 * Query and filter control vocabulary shared by the browsing pages and their query editors
 * (docs/ui/editors.md, docs/ui/pages.md#page-map).
 *
 * The values are the provider vocabularies Search and Catalog publish; the lists are declared once
 * here because the pages and editors present the same controls and a provider change needs one
 * deliberate decision about the criteria the views serve.
 */

import type { Finish } from '../../catalog/index.js';
import type { SearchResultLevel } from '../../search/index.js';

/** Result levels the catalog page presents; a physical copy belongs to the collection views. */
export const uiCatalogLevels = ['card', 'printing'] as const satisfies readonly SearchResultLevel[];
export type UiCatalogLevel = (typeof uiCatalogLevels)[number];

/**
 * Result levels the collection views present. The collection exposes the card, printing and
 * physical-copy levels of the account's owned records.
 */
export const uiCollectionLevels = [
  'card',
  'printing',
  'copy',
] as const satisfies readonly SearchResultLevel[];
export type UiCollectionLevel = (typeof uiCollectionLevels)[number];

/** Finishes the catalog query's finish control offers, as Catalog publishes them. */
export const uiCatalogFinishes = ['nonfoil', 'foil', 'etched'] as const satisfies readonly Finish[];

/** Display name of one printing finish. */
export function uiFinishLabel(finish: Finish): string {
  switch (finish) {
    case 'nonfoil':
      return 'Nonfoil';
    case 'foil':
      return 'Foil';
    case 'etched':
      return 'Etched';
  }
}

/** Result level one catalog control names; an absent or unknown value presents cards. */
export function readUiCatalogLevel(value: unknown): UiCatalogLevel {
  return value === 'printing' ? 'printing' : 'card';
}

/** Result level one collection control names; an absent or unknown value presents cards. */
export function readUiCollectionLevel(value: unknown): UiCollectionLevel {
  return value === 'printing' || value === 'copy' ? value : 'card';
}

/** Finish one catalog control names, or null when it is absent or outside the vocabulary. */
export function readUiCatalogFinish(value: unknown): Finish | null {
  if (typeof value !== 'string') {
    return null;
  }
  return (uiCatalogFinishes as readonly string[]).includes(value) ? (value as Finish) : null;
}
