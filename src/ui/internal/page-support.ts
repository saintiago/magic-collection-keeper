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

import { cardListBasicContent, type UiCardList, type UiCardListState } from './card-list.js';
import type { UiListEntry } from './list.js';
import type { UiPageHandle } from './pages.js';
import { UI_LIMITS } from './limits.js';
import { uiHref, type UiView } from './routes.js';

/** One option of a select control the pages present. */
export interface UiSelectOption {
  readonly value: string;
  readonly label: string;
}

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
    ...(restoration === null ? {} : { presented: () => restoration.presented }),
    dispose: () => list.dispose(),
  };
}

/**
 * Presentation that opens one entry's card details. The link carries a stable identity of the
 * entry it opens, so the list and the shell restore the focused and visible result of a history
 * entry by that identity; an entry without resolved basic information has no details to open and
 * keeps the default rendering.
 */
export function openEntryPresentation(
  document: Document,
  idPrefix: string,
  onOpen: (entry: UiListEntry) => void = () => {},
): { renderEntry(entry: UiListEntry): Node | null } {
  return {
    renderEntry(entry) {
      const content = cardListBasicContent(document, entry);
      const view = cardViewOf(entry);
      if (view === null) {
        return content;
      }
      const link = document.createElement('a');
      link.id = `${idPrefix}-${encodeURIComponent(entry.key)}`;
      link.href = uiHref(view);
      link.dataset.uiOpen = entry.key;
      link.append(content);
      link.addEventListener('click', () => onOpen(entry));
      return link;
    },
  };
}

/** Card details view of one entry, or null when the entry carries no identity to open. */
export function cardViewOf(entry: UiListEntry): UiView | null {
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
  }
}

/**
 * The search expression field the browsing and collection pages present. The field carries an id,
 * so the shell restores this page's focus to it when the user returns to the view
 * (docs/user-interface.md#pages-and-navigation).
 */
export function searchInput(document: Document, id: string): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'search';
  input.name = 'query';
  // The page bounds the draft it keeps and the URL of a query it links, so the captured input
  // always fits the state the page retains.
  input.maxLength = UI_LIMITS.catalogQuery;
  return input;
}

/** One search form: the expression, the query controls and the control that submits them. */
export function searchForm(
  document: Document,
  input: HTMLInputElement,
  controls: readonly HTMLElement[] = [],
  caption = 'Search cards',
): HTMLFormElement {
  const form = document.createElement('form');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Search';
  form.append(controlLabel(document, caption, input), ...controls, submit);
  return form;
}

/** One select control with the supplied options and an initial value. */
export function selectControl(
  document: Document,
  options: readonly UiSelectOption[],
  value: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  select.value = value;
  return select;
}

/** One control beside its caption; the label names the control it contains. */
export function controlLabel(
  document: Document,
  text: string,
  control: HTMLElement,
): HTMLLabelElement {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = text;
  label.append(caption, control);
  return label;
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
): UiCardListState<Context> | undefined {
  const list = state?.list;
  return typeof list === 'object' && list !== null && !Array.isArray(list)
    ? (list as UiCardListState<Context>)
    : undefined;
}
