/**
 * Browsing pages of the UserInterface (docs/ui/navigation.md,
 * docs/ui/pages.md#page-map, docs/card-list.md).
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
 * (docs/ui/architecture.md#state-ownership-and-restoration). Every provider value renders as text.
 *
 * The activity of an account ends with that account, whatever page the shell presents when it
 * leaves it (docs/ui/capture-controls.md).
 */

import type { CardListCatalogQuery } from '../../../card-list/index.js';

import { UI_LIMITS } from '../../shared/limits.js';
import { uiHref, type UiPageDefinition, type UiView } from '../../navigation/index.js';
import { cardViewOf, pageHandle, readListState, readPageState } from './page-support.js';

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
      const editor = context.modules.editors.searchEntry({
        document,
        applied: '',
        restored,
        onSubmit: (query) => {
          context.navigate(catalogView({ text: query, level: 'card', owned: false, finish: null }));
        },
      });
      const heading = document.createElement('h2');
      heading.textContent = 'Recent cards';
      const listHost = document.createElement('div');
      listHost.id = 'home-results';
      container.append(editor.element, heading, listHost);

      const list = context.modules.cardViews.list({
        container: listHost,
        create: context.capabilities.cardList.create,
        source: recent.source,
        context: accountId,
        accountId,
        pageSize: UI_LIMITS.recentCards,
        changes: bindings.changes(),
        fragments: { ownership: bindings.ownership(null) },
        restored: readListState<string>(restored),
        presentation: context.modules.cardViews.openEntries({
          document,
          idPrefix: 'home-result',
          href: (entry) => openableHref(entry),
          onOpen: (entry) => recent.record(entry),
        }),
        signal: context.signal,
      });

      return pageHandle(list, () => ({ ...editor.capture(), list: list.capture() }));
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
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.id = 'catalog-refresh';
      refresh.textContent = 'Refresh results';
      const heading = document.createElement('h2');
      heading.textContent = 'Results';
      const listHost = document.createElement('div');
      listHost.id = 'catalog-results';
      container.append(heading, refresh, listHost);

      const bindings = context.capabilities.cardList.account(context.account.accountId);
      const recent = bindings.recent();
      const list = context.modules.cardViews.list<CardListCatalogQuery>({
        container: listHost,
        create: context.capabilities.cardList.create,
        source: bindings.catalogQuery(),
        context: catalogQueryOf(view),
        accountId: context.account.accountId,
        // Private changes refresh enrichment independently of public membership.
        changes: bindings.changes(),
        pageSize: UI_LIMITS.catalogPage,
        restored: readListState<CardListCatalogQuery>(restored),
        fragments: {
          ownership: bindings.ownership(null),
          ...(view.level === 'printing' ? { images: bindings.printingImages() } : {}),
        },
        presentation: context.modules.cardViews.openEntries({
          document,
          idPrefix: 'catalog-result',
          href: (entry) => openableHref(entry),
          onOpen: (entry) => recent.record(entry),
        }),
        signal: context.signal,
      });
      const editor = context.modules.editors.catalogQuery({
        document,
        applied: catalogQueryOf(view),
        restored,
        onSubmit: (criteria) => {
          const next = catalogView(criteria);
          if (uiHref(next) === uiHref(view)) {
            // The same view is already presented: restart its result instead of adding an entry.
            list.refresh();
            return;
          }
          context.navigate(next);
        },
      });
      container.prepend(editor.element);
      refresh.addEventListener('click', () => {
        list.refresh();
      });

      return pageHandle(list, () => ({ ...editor.capture(), list: list.capture() }));
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

/** Location one presented entry opens, or null when it carries no openable identity. */
function openableHref(entry: Parameters<typeof cardViewOf>[0]): string | null {
  const target = cardViewOf(entry);
  return target === null ? null : uiHref(target);
}
