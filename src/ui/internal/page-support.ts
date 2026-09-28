/**
 * Page support of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#state-ownership-and-restoration).
 *
 * The dedicated pages compose the same building blocks around their own query and their own lists:
 * the bounded text field and select controls of a query form, the entry presentation that opens the
 * card details a presented entry names, the page handle that hands a list's restoration to the
 * shell, and the page-state reading that interprets only the representation the page itself
 * retained. The helpers own no page's query, list or form state; they keep each page's own
 * representation opaque to the others.
 */

import type { CardListEntry, CardListRetained } from '../../card-list/index.js';

import type { UiCardList } from '../card-views/index.js';
import type { UiPageHandle } from './pages.js';
import type { UiView } from './routes.js';

// The field controls live with the shared presentation code; pages keep importing them from the
// page support they already use.
export {
  controlLabel,
  searchForm,
  searchInput,
  selectControl,
  type UiSelectOption,
} from '../shared/controls.js';

/**
 * One page's handle: the page keeps its own form state beside the state its list retains, and it
 * reports the list's restoration lifecycle while the list is still acquiring a retained window
 * (docs/user-interface.md#state-ownership-and-restoration).
 */
export function pageHandle<Context>(
  list: UiCardList<Context>,
  capture: () => unknown,
): UiPageHandle {
  const restoration = list.restoration;
  return {
    capture,
    ...(restoration === null ? {} : { presented: presented(list) }),
    dispose: () => list.dispose(),
  };
}

/**
 * The list's restoration as the page lifecycle reports it: the shell restores its own scroll and
 * focus once the list presented the retained window of this page, and the list's own logical
 * position is applied by the view that mounts it.
 */
export function presented<Context>(list: UiCardList<Context>): () => Promise<void> {
  return async () => {
    await restoredPresentation(list);
  };
}

/**
 * The list's restoration as one page child reports it, or null when this visit restored none. The
 * page reports the interruption when it rejects; the shell keeps the entry's own context then.
 */
export function restoredPresentation<Context>(list: UiCardList<Context>): Promise<void> | null {
  const restoration = list.restoration;
  return restoration === null ? null : restoration.presented.then(() => undefined);
}

/** Card details view of one entry, or null when the entry carries no identity to open. */
export function cardViewOf(entry: CardListEntry): UiView | null {
  const basic = entry.basic;
  if (basic === null) {
    return null;
  }
  switch (entry.target.kind) {
    case 'card':
      return { page: 'card', cardId: entry.target.cardId, printingId: null, copyId: null };
    case 'printing':
      return {
        page: 'card',
        cardId: basic.card.cardId,
        printingId: entry.target.printingId,
        copyId: null,
      };
    case 'copy': {
      const printingId = basic.printing?.printingId ?? null;
      return printingId === null
        ? null
        : {
            page: 'card',
            cardId: basic.card.cardId,
            printingId,
            copyId: entry.target.copyId,
          };
    }
    case 'pending':
      // A pending import entry has no catalog record to open before its confirmation.
      return null;
  }
}

/**
 * The page state a history entry kept, or null when it kept none. The page owns this shape and
 * interprets it; the shell hands it back without reading or restricting it
 * (docs/user-interface.md#state-ownership-and-restoration).
 */
export function readPageState(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The list state one page kept, or undefined when this visit restored none. */
export function readListState<Context>(
  state: Readonly<Record<string, unknown>> | null,
): CardListRetained<Context> | undefined {
  const list = state?.list;
  return typeof list === 'object' && list !== null && !Array.isArray(list)
    ? (list as CardListRetained<Context>)
    : undefined;
}
