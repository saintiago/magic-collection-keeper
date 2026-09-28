/**
 * Editors implementation (docs/ui/editors.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * One Editors module provides the independently mountable editors of the UserInterface over a
 * supplied CardViews module: query/filter input, copy attributes, tags, associations and
 * location, import source input, pending review and confirmation. An editor owns its unsaved draft
 * and its operation presentation; business validation, import identity, replay, ownership and
 * location rules stay with the provider-owned operations.
 */

import type { CardViews } from '../../card-views/index.js';

export interface EditorsOptions {
  /**
   * CardViews factory the editors use for card and printing choices; the editors never select a
   * concrete renderer themselves (docs/ui/architecture.md#modules-and-composition).
   */
  readonly cardViews: CardViews;
}

/** The presentation module of the UI composition. */
export interface Editors {
  readonly cardViews: CardViews;
}

/** The default Editors module of the browser application. */
export function createEditors(options: EditorsOptions): Editors {
  if (options?.cardViews === undefined) {
    throw new TypeError('The editors render card choices through the supplied CardViews module.');
  }
  return { cardViews: options.cardViews };
}
