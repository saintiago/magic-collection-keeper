/**
 * Browsing pages of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization).
 *
 * Home presents bounded, account-isolated recent card activity: the cards the account opened while
 * browsing, read back through the list boundary, beside the search entry that opens the catalog.
 * Catalog presents search over the catalog: the text expression and the result-level, owned-only
 * and finish controls build one query, the URL carries that query so a reload or a direct entry
 * presents the same result, and CardList presents the entries with their basic information and the
 * printing images the supplied contracts provide. Opening an entry navigates to its card details
 * and records it as the account's activity; both pages keep their input, controls and selection in
 * the shell's bounded state for the way back, and every provider value renders as text.
 *
 * Returning to a browsing view also presents the result window the history entry kept: the page
 * reloads the further pages of the same result and reports its presentation, so the shell restores
 * the entry's scroll offset and focused result over entries the source supplies asynchronously
 * (docs/user-interface.md#pages-and-navigation). The activity of an account ends with that
 * account, whatever page the shell presents when it leaves it
 * (docs/user-interface.md#capture-and-review).
 */

import type { UiCardList, UiCardListPresentation, UiListPosition } from './card-list.js';
import { cardListBasicContent, createCardList } from './card-list.js';
import { UI_LIMITS } from './limits.js';
import type { UiListEntry, UiListSource } from './list.js';
import type { UiPageDefinition } from './pages.js';
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
  return [browsePage(homePage(recent), recent), browsePage(catalogPage(recent), recent)];
}

/**
 * One browsing page of the shared recent activity. The shell reports the account it leaves to every
 * page implementation, so the activity ends with that account even when the page presented at that
 * moment is another one, and neither another account nor a later sign-in of the same account reads
 * it again (docs/user-interface.md#capture-and-review).
 */
function browsePage(definition: UiPageDefinition, recent: UiRecentCards): UiPageDefinition {
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
      // A browsing page presents one account: activity another account recorded before leaves the
      // UI instead of being presented again later (docs/user-interface.md#pages-and-navigation).
      recent.retain(accountId);
      const restored = context.restored?.state ?? null;
      const pageSize = UI_LIMITS.recentCards;
      const restoredWindow =
        context.restored === null ? null : restoreResultWindow(readLoadedWindow(restored));
      const input = searchInput(document, 'home-search');
      const form = searchForm(document, input);
      const heading = document.createElement('h2');
      heading.textContent = 'Recent cards';
      const listHost = document.createElement('div');
      listHost.id = `${context.view.page}-results`;
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
        pageSize,
        initialPosition: readPosition(restored, pageSize),
        presentation: openEntryPresentation(document, 'home-result', (entry) =>
          recent.record(accountId, entry),
        ),
        onWindowSettled: (settled) => restoredWindow?.settle(settled),
        signal: context.signal,
      });

      const restoredQuery = restoredValue(restored, 'query');
      if (typeof restoredQuery === 'string') {
        input.value = restoredQuery;
      }
      restoreSelection(list, restoredValue(restored, 'selection'));
      return {
        capture: () => ({
          query: input.value,
          selection: [...list.selection],
          loaded: list.entries.length,
          continuation: list.position?.continuation ?? null,
          offset: list.position?.offset ?? 0,
        }),
        ...(restoredWindow === null ? {} : { presented: () => restoredWindow.presented }),
      };
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
      recent.retain(context.account.accountId);
      const restored = context.restored?.state ?? null;
      const pageSize = UI_LIMITS.catalogPage;
      const restoredWindow =
        context.restored === null ? null : restoreResultWindow(readLoadedWindow(restored));
      const document = container.ownerDocument;
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
      listHost.id = `${context.view.page}-results`;
      container.append(form, heading, refresh, listHost);

      const access = createCatalogSearchAccess(
        context.capabilities.search,
        context.capabilities.catalog,
      );
      const query: UiCatalogQuery = {
        text: view.query,
        level: view.level,
        owned: view.owned,
        finish: view.finish,
      };
      const list = createCardList<UiCatalogQuery>({
        container: listHost,
        source: access.source,
        context: query,
        pageSize,
        initialPosition: readPosition(restored, pageSize),
        ...(view.level === 'printing' ? { fragments: { images: access.images } } : {}),
        presentation: openEntryPresentation(document, 'catalog-result', (entry) =>
          recent.record(context.account.accountId, entry),
        ),
        onWindowSettled: (settled) => restoredWindow?.settle(settled),
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

      const restoredQuery = restoredValue(restored, 'query');
      if (typeof restoredQuery === 'string') {
        input.value = restoredQuery;
      }
      const restoredLevel = restoredValue(restored, 'level');
      if (typeof restoredLevel === 'string') {
        level.value = readUiCatalogLevel(restoredLevel);
      }
      const restoredOwned = restoredValue(restored, 'owned');
      if (typeof restoredOwned === 'boolean') {
        owned.checked = restoredOwned;
      }
      const restoredFinish = restoredValue(restored, 'finish');
      if (restoredFinish !== undefined) {
        finish.value = readUiCatalogFinish(restoredFinish) ?? '';
      }
      restoreSelection(list, restoredValue(restored, 'selection'));
      return {
        capture: () => ({
          query: input.value,
          level: level.value,
          owned: owned.checked,
          finish: finish.value === '' ? null : finish.value,
          selection: [...list.selection],
          // The entries the presented window held, so the way back presents the same window of the
          // same result instead of its first page (docs/user-interface.md#pages-and-navigation).
          loaded: list.entries.length,
          continuation: list.position?.continuation ?? null,
          offset: list.position?.offset ?? 0,
        }),
        ...(restoredWindow === null ? {} : { presented: () => restoredWindow.presented }),
      };
    },
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
 * activity. The link carries a stable identity of the entry it opens, so the shell restores the
 * focused result of a history entry by that identity; an entry without resolved basic information
 * has no details to open and keeps the default rendering.
 */
function openEntryPresentation(
  document: Document,
  idPrefix: string,
  onOpen: (entry: UiListEntry) => void,
): UiCardListPresentation {
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

/**
 * The result window one history entry kept, restored when the page returns
 * (docs/user-interface.md#pages-and-navigation). The entry had loaded a window of one result; the
 * page asks the list for the further pages of the same result until that window is back, bounded by
 * the pages one bounded window can hold, and then reports the presentation, so the shell restores
 * the entry's scroll offset and focused result over the entries it names.
 */
interface UiRestoredWindow {
  /** Resolves once the window the history entry kept is presented again. */
  readonly presented: Promise<void>;
  /** One settled list window: reload what is missing, then report the presentation. */
  settle(list: UiWindowList): void;
}

/** The list state restoring a result window reads: its entries, its continuation and its status. */
interface UiWindowList {
  readonly entries: readonly UiListEntry[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  loadMore(): void;
}

/** Reloads one result window page by page, within the pages one bounded window can hold. */
function restoreResultWindow(loaded: number): UiRestoredWindow {
  const presented = Promise.withResolvers<void>();
  // A provider may return short pages. Every productive request adds at least one entry; one
  // additional request can make no progress before restoration stops.
  const pageBudget = UI_LIMITS.listWindow;
  let previousLength = -1;
  let asked = 0;
  let done = false;
  return {
    presented: presented.promise,
    settle(list) {
      if (done || list.loading) {
        return;
      }
      if (
        list.entries.length < loaded &&
        list.entries.length > previousLength &&
        list.hasMore &&
        asked < pageBudget
      ) {
        previousLength = list.entries.length;
        asked += 1;
        list.loadMore();
        return;
      }
      done = true;
      presented.resolve();
    },
  };
}

/** The source owns the opaque cursor; only the within-page offset is interpreted here. */
function readPosition(
  restored: Readonly<Record<string, unknown>> | null,
  pageSize: number,
): UiListPosition {
  const continuation = restoredValue(restored, 'continuation');
  const offset = restoredValue(restored, 'offset');
  return {
    continuation: typeof continuation === 'string' ? continuation : null,
    offset:
      typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 && offset < pageSize
        ? offset
        : 0,
  };
}

/** Entries the window of one restored history entry had loaded, or none when it kept no window. */
function readLoadedWindow(restored: Readonly<Record<string, unknown>> | null): number {
  const value = restoredValue(restored, 'loaded');
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, UI_LIMITS.listWindow)
    : 0;
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
  // The shell keeps at most this many characters of a captured draft, so the input a page captures
  // always fits that state (docs/user-interface.md#pages-and-navigation).
  input.maxLength = UI_LIMITS.restorationText;
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

/** One value the shell kept for this history entry, or undefined when it kept none. */
function restoredValue(restored: Readonly<Record<string, unknown>> | null, key: string): unknown {
  return restored !== null && Object.hasOwn(restored, key) ? restored[key] : undefined;
}

/** Selects the keys the shell restored, so the way back presents the same interaction state. */
function restoreSelection<Context>(list: UiCardList<Context>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const key of value) {
    if (typeof key === 'string' && key.length > 0) {
      list.setSelected(key, true);
    }
  }
}
