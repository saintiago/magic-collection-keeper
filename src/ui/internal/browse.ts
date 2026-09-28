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

import type { CardListCatalogQuery } from '../../card-list/index.js';

import { createCardListView } from './card-list.js';
import { UI_LIMITS } from './limits.js';
import type { UiPageDefinition } from './pages.js';
import {
  controlLabel,
  openEntryPresentation,
  pageHandle,
  readListState,
  readPageState,
  searchForm,
  searchInput,
  selectControl,
} from './page-support.js';
import {
  readUiCatalogFinish,
  readUiCatalogLevel,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiFinishLabel,
  uiHref,
  type UiView,
} from './routes.js';

/**
 * The browsing pages Application's capabilities present: Home and the catalog/search page. They
 * share the CardList capability's account-scoped activity, so a card the account opens in the
 * catalog appears on Home and no other account ever sees it.
 */
export function createBrowsePages(): readonly UiPageDefinition[] {
  return [homePage(), catalogPage()];
}

/** Home: the search entry that opens the catalog and the account's recent card activity. */
function homePage(): UiPageDefinition {
  return {
    page: 'home',
    mount(container, context) {
      const document = container.ownerDocument;
      const accountId = context.account.accountId;
      const bindings = context.capabilities.cardList.account(accountId);
      const recent = bindings.recent();
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

      const list = createCardListView({
        container: listHost,
        create: context.capabilities.cardList.create,
        source: recent.source,
        context: accountId,
        accountId,
        pageSize: UI_LIMITS.recentCards,
        restored: readListState<string>(restored),
        presentation: openEntryPresentation(document, 'home-result', (entry) =>
          recent.record(entry),
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
function catalogPage(): UiPageDefinition {
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
      const level = catalogLevelSelect(document);
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

      const bindings = context.capabilities.cardList.account(context.account.accountId);
      const recent = bindings.recent();
      const list = createCardListView<CardListCatalogQuery>({
        container: listHost,
        create: context.capabilities.cardList.create,
        source: bindings.catalogQuery(),
        context: catalogQueryOf(view),
        accountId: context.account.accountId,
        // A committed private change can alter an owned-only query, so the list reacquires the
        // result through Search with the position the change reported.
        changes: bindings.changes(),
        pageSize: UI_LIMITS.catalogPage,
        restored: readListState<CardListCatalogQuery>(restored),
        ...(view.level === 'printing' ? { fragments: { images: bindings.printingImages() } } : {}),
        presentation: openEntryPresentation(document, 'catalog-result', (entry) =>
          recent.record(entry),
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

/** The query the catalog page presents for one view. */
function catalogQueryOf(view: Extract<UiView, { page: 'catalog' }>): CardListCatalogQuery {
  return {
    text: view.query,
    level: view.level,
    owned: view.owned,
    finish: view.finish,
  };
}

/** One catalog view from a query; the URL then identifies the whole presented query. */
function catalogView(query: CardListCatalogQuery): UiView {
  return {
    page: 'catalog',
    query: query.text,
    // The catalog route presents the card and printing levels; a copy-level query belongs to the
    // collection and organization pages.
    level: query.level === 'printing' ? 'printing' : 'card',
    owned: query.owned,
    finish: query.finish,
  };
}

/** Result level control of the catalog page. */
function catalogLevelSelect(document: Document): HTMLSelectElement {
  return selectControl(
    document,
    uiCatalogLevels.map((level) => ({
      value: level,
      label: level === 'card' ? 'Cards' : 'Printings',
    })),
    'card',
  );
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
    option.textContent = uiFinishLabel(finish);
    select.append(option);
  }
  return select;
}
