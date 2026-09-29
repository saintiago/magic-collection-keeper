import { cardViewsEntry } from '../card-views/index.js';
import { navigationEntry } from '../navigation/index.js';

// The type-only internal import is the fixture's negative: it must fail exactly like a value
// import, because a page that names another module's private types depends on its internals.
import type { DetailView } from '../card-views/internal/detail.js';

/** Pages composes Navigation and CardViews; the CardViews internal import is the fixture's negative. */
export const pagesEntry = { navigationEntry, cardViewsEntry };

export function presentDetail(view: DetailView): string {
  return view.kind;
}
