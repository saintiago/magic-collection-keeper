/**
 * Browsing pages of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-interface.md#cardlist).
 *
 * Home presents bounded, account-isolated recent card activity: the cards the account opened while
 * browsing, read back through the list boundary, beside the search entry that opens the catalog.
 * Catalog presents search over the catalog: the text expression and the result-level, owned-only
 * and finish controls build one query, the URL carries that query so a reload or a direct entry
 * presents the same result, and CardList presents the entries with their basic information and the
 * printing images the supplied contracts provide. Opening an entry navigates to its card details
 * and records it as the account's activity; both pages keep their form input and query
 * bookkeeping in the shell's bounded state and hand the state of their list back through CardList's
 * own capture and restoration contract, so the list decides how to re-acquire the window it held
 * (docs/user-interface.md#state-ownership-and-restoration). Every provider value renders as text.
 *
 * The activity of an account ends with that account, whatever page the shell presents when it
 * leaves it (docs/user-interface.md#capture-and-review).
 */

import type { UiCardList, UiCardListState } from './card-list.js';
import { cardListBasicContent, createCardList } from './card-list.js';
import { UI_LIMITS } from './limits.js';
import type { UiListEntry, UiListSource } from './list.js';
import type { UiPageDefinition, UiPageHandle } from './pages.js';
import { createRecentCards, type UiRecentCards } from './recent.js';
import {
  readUiCatalogFinish,
  readUiCatalogLevel,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiHref,
  type UiView,
} from './routes.js';
import { createCatalogSearchAccess, type UiCatalogQuery } from './search-source.js';

/**
 * The browsing pages Application's capabilities present: Home and the catalog/search page. They
 * share one bounded store of recent card activity, so a card the account opens in the catalog
 * appears on Home and no other account ever sees it.
 */
export function createBrowsePages(): readonly UiPageDefinition[] {
  const recent = createRecentCards();
  return [
    withRecentCleanup(homePage(recent), recent),
    withRecentCleanup(catalogPage(recent), recent),
  ];
}

/**
 * One browsing page of the shared recent activity. The shell reports the account it leaves to every
 * page implementation, so the activity ends with that account even when the page presented at that
 * moment is another one, and neither another account nor a later sign-in of the same account reads
 * it again (docs/user-interface.md#capture-and-review).
 */
function withRecentCleanup(definition: UiPageDefinition, recent: UiRecentCards): UiPageDefinition {
  return {
    ...definition,
    accountEnded: (accountId) => recent.clear(accountId),
  };
}

/** Home: the search entry that opens the catalog and the account's recent card activity. */
function homePage(recent: UiRecentCards): UiPageDefinition {
  return {
    page: 'home',
    mount(container, context) {
      const document = container.ownerDocument;
      const accountId = context.account.accountId;
      const restored = readPageState(context.restored?.state);
      const input = searchInput(document, 'home-search');
      const form = searchForm(document, input);
      const heading = document.createElement('h2');
      heading.textContent = 'Recent cards';
      const listHost = document.createElement('div');
      listHost.id = 'home-results';
      container.append(form, heading, listHost);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        context.navigate(
          catalogView({
            text: input.value.trim(),
            level: 'card',
            owned: false,
            finish: null,
          }),
        );
      });

      const list = createCardList<string>({
        container: listHost,
        source: recentSource(recent),
        context: accountId,
        pageSize: UI_LIMITS.recentCards,
        restored: readListState<string>(restored),
        presentation: openEntryPresentation(document, 'home-result', (entry) =>
          recent.record(accountId, entry),
        ),
        signal: context.signal,
      });

      if (typeof restored?.query === 'string') {
        input.value = restored.query;
      }
      return pageHandle(list, () => ({ query: input.value, list: list.capture() }));
    },
  };
}

/** Catalog and search: the query of the presented view and the CardList that presents its entries. */
function catalogPage(recent: UiRecentCards): UiPageDefinition {
  return {
    page: 'catalog',
    mount(container, context) {
      const view = context.view;
      if (view.page !== 'catalog') {
        return;
      }
      const document = container.ownerDocument;
      const restored = readPageState(context.restored?.state);
      const input = searchInput(document, 'catalog-search');
      input.value = view.query;
      const level = levelSelect(document);
      level.id = 'catalog-level';
      level.value = view.level;
      const owned = document.createElement('input');
      owned.type = 'checkbox';
      owned.id = 'catalog-owned';
      owned.checked = view.owned;
      const finish = finishSelect(document);
      finish.id = 'catalog-finish';
      finish.value = view.finish ?? '';
      const form = searchForm(document, input, [
        controlLabel(document, 'Result level', level),
        controlLabel(document, 'Owned only', owned),
        controlLabel(document, 'Finish', finish),
      ]);
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.id = 'catalog-refresh';
      refresh.textContent = 'Refresh results';
      const heading = document.createElement('h2');
      heading.textContent = 'Results';
      const listHost = document.createElement('div');
      listHost.id = 'catalog-results';
      container.append(form, heading, refresh, listHost);

      const access = createCatalogSearchAccess(
        context.capabilities.search,
        context.capabilities.catalog,
      );
      const list = createCardList<UiCatalogQuery>({
        container: listHost,
        source: access.source,
        context: catalogQueryOf(view),
        pageSize: UI_LIMITS.catalogPage,
        restored: readListState<UiCatalogQuery>(restored),
        ...(view.level === 'printing' ? { fragments: { images: access.images } } : {}),
        presentation: openEntryPresentation(document, 'catalog-result', (entry) =>
          recent.record(context.account.accountId, entry),
        ),
        signal: context.signal,
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const next = catalogView({
          text: input.value.trim(),
          level: readUiCatalogLevel(level.value),
          owned: owned.checked,
          finish: readUiCatalogFinish(finish.value),
        });
        if (uiHref(next) === uiHref(view)) {
          // The same view is already presented: restart its result instead of adding an entry.
          list.refresh();
          return;
        }
        context.navigate(next);
      });
      refresh.addEventListener('click', () => {
        list.refresh();
      });

      if (typeof restored?.query === 'string') {
        input.value = restored.query;
      }
      if (typeof restored?.level === 'string') {
        level.value = readUiCatalogLevel(restored.level);
      }
      if (typeof restored?.owned === 'boolean') {
        owned.checked = restored.owned;
      }
      if (restored?.finish !== undefined) {
        finish.value = readUiCatalogFinish(restored.finish) ?? '';
      }
      return pageHandle(list, () => ({
        query: input.value,
        level: level.value,
        owned: owned.checked,
        finish: finish.value === '' ? null : finish.value,
        list: list.capture(),
      }));
    },
  };
}

/**
 * One page's handle: the page keeps its own form state beside the state its list retains, and it
 * reports the list's restoration lifecycle while the list is still acquiring a retained window
 * (docs/user-interface.md#state-ownership-and-restoration).
 */
function pageHandle<Context>(list: UiCardList<Context>, capture: () => unknown): UiPageHandle {
  const restoration = list.restoration;
  return {
    capture,
    ...(restoration === null ? {} : { presented: () => restoration.presented }),
    dispose: () => list.dispose(),
  };
}

/** The query the catalog page presents for one view. */
function catalogQueryOf(view: Extract<UiView, { page: 'catalog' }>): UiCatalogQuery {
  return {
    text: view.query,
    level: view.level,
    owned: view.owned,
    finish: view.finish,
  };
}

/** One catalog view from a query; the URL then identifies the whole presented query. */
function catalogView(query: UiCatalogQuery): UiView {
  return {
    page: 'catalog',
    query: query.text,
    level: query.level,
    owned: query.owned,
    finish: query.finish,
  };
}

/** Home's list source: the account's recorded activity, which ends after that one page. */
function recentSource(recent: UiRecentCards): UiListSource<string> {
  return {
    load(request) {
      return Promise.resolve({ entries: recent.entries(request.context), continuation: null });
    },
  };
}

/**
 * Presentation that opens one entry's card details and records the entry as the account's recent
 * activity. The link carries a stable identity of the entry it opens, so the list and the shell
 * restore the focused and visible result of a history entry by that identity; an entry without
 * resolved basic information has no details to open and keeps the default rendering.
 */
function openEntryPresentation(
  document: Document,
  idPrefix: string,
  onOpen: (entry: UiListEntry) => void,
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
function cardViewOf(entry: UiListEntry): UiView | null {
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
 * The search expression field both browsing pages present. The field carries an id, so the shell
 * restores this page's focus to it when the user returns to the view
 * (docs/user-interface.md#pages-and-navigation).
 */
function searchInput(document: Document, id: string): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'search';
  input.name = 'query';
  // The page bounds the draft it keeps and the URL of a catalog query it links, so the captured
  // input always fits the state the page retains.
  input.maxLength = UI_LIMITS.catalogQuery;
  return input;
}

/** One search form: the expression, the catalog controls and the control that submits them. */
function searchForm(
  document: Document,
  input: HTMLInputElement,
  controls: readonly HTMLElement[] = [],
): HTMLFormElement {
  const form = document.createElement('form');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Search';
  form.append(controlLabel(document, 'Search cards', input), ...controls, submit);
  return form;
}

/** Result level control of the catalog page. */
function levelSelect(document: Document): HTMLSelectElement {
  const select = document.createElement('select');
  for (const level of uiCatalogLevels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level === 'card' ? 'Cards' : 'Printings';
    select.append(option);
  }
  return select;
}

/** Finish control of the catalog page; the empty value means the query constrains no finish. */
function finishSelect(document: Document): HTMLSelectElement {
  const select = document.createElement('select');
  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'Any finish';
  select.append(any);
  for (const finish of uiCatalogFinishes) {
    const option = document.createElement('option');
    option.value = finish;
    option.textContent = finish === 'nonfoil' ? 'Nonfoil' : finish === 'foil' ? 'Foil' : 'Etched';
    select.append(option);
  }
  return select;
}

/** One control beside its caption; the label names the control it contains. */
function controlLabel(document: Document, text: string, control: HTMLElement): HTMLLabelElement {
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
function readPageState(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The list state one page kept, or undefined when this visit restored none. */
function readListState<Context>(
  state: Readonly<Record<string, unknown>> | null,
): UiCardListState<Context> | undefined {
  const list = state?.list;
  return typeof list === 'object' && list !== null && !Array.isArray(list)
    ? (list as UiCardListState<Context>)
    : undefined;
}
