/**
 * Collection pages of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization).
 *
 * The collection view presents the account's owned records through the list boundary: the text
 * expression and the level control of the presented view build one Search query restricted to
 * owned entries, the URL carries that query so a reload or a direct entry presents the same result,
 * and the entries show the counts the result evaluated — physical copies and intended quantities —
 * distinctly. At the physical-copy level every copy stays an individual entry, so equivalent
 * copies group for convenient bulk selection without losing their individual identities, and the
 * bulk changes apply to the explicit selected copy identities through the private UserCards
 * contract. Opening an entry presents its card, printing or copy details, which the card-details
 * page implements.
 *
 * The page keeps its form input and query bookkeeping in the shell's bounded state and hands the
 * state of its list back through CardList's own capture and restoration contract, so the list
 * decides how to re-acquire the window it held
 * (docs/user-interface.md#state-ownership-and-restoration). Every provider value renders as text.
 */

import { type CardListCollectionQuery } from '../../card-list/index.js';

import { createCopyAccess } from '../editors/index.js';
import { createCardDetailsPage } from './card-details.js';
import { UI_LIMITS } from '../shared/limits.js';
import { cardViewOf, pageHandle, readListState, readPageState } from './page-support.js';
import type { UiPageDefinition } from './pages.js';
import { uiHref, type UiView } from './routes.js';

/** The two collection views: the account's collection and one card's details. */
export function createCollectionPages(): readonly UiPageDefinition[] {
  return [collectionPage(), createCardDetailsPage()];
}

/** The collection result: owned entries of the level the URL names, with their bulk copy changes. */
function collectionPage(): UiPageDefinition {
  return {
    page: 'collection',
    mount(container, context) {
      const view = context.view;
      if (view.page !== 'collection') {
        return;
      }
      const document = container.ownerDocument;
      const restored = readPageState(context.restored?.state);
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.id = 'collection-refresh';
      refresh.textContent = 'Refresh collection';

      const account = context.capabilities.userCards.account(context.account.accountId);
      const copies = createCopyAccess(account);
      const changes = context.modules.editors.copyBulk({
        document,
        access: copies,
        signal: context.signal,
        restored,
      });
      const heading = document.createElement('h2');
      heading.textContent = 'Your collection';
      const listHost = document.createElement('div');
      listHost.id = 'collection-results';
      container.append(refresh, changes.element, heading, listHost);

      const bindings = context.capabilities.cardList.account(context.account.accountId);
      const list = context.modules.cardViews.list<CardListCollectionQuery>({
        container: listHost,
        create: context.capabilities.cardList.create,
        source: bindings.collectionQuery(),
        context: collectionQueryOf(view),
        accountId: context.account.accountId,
        // A committed change of the account's copies makes this result stale: the list reacquires
        // it through Search instead of a page patching the presented rows.
        changes: bindings.changes(),
        pageSize: UI_LIMITS.catalogPage,
        restored: readListState<CardListCollectionQuery>(restored),
        fragments: {
          // A printing entry names the printing its image belongs to; a physical copy is presented
          // with the printing of its group, so only the printing level loads images.
          ...(view.level === 'printing' ? { images: bindings.printingImages() } : {}),
          tools: context.capabilities.cardList
            .account(context.account.accountId)
            .copyTools(['apply-finish', 'apply-condition']),
        },
        tools: changes.actions,
        onAction: (intent) => changes.apply(intent),
        presentation: {
          ...context.modules.cardViews.openEntries({
            document,
            idPrefix: 'collection-entry',
            href: (entry) => openableHref(entry),
          }),
          renderFragment(kind, entry) {
            // Only copies offer bulk changes; other entries present no tool availability at all.
            return kind === 'tools' && entry.target.kind !== 'copy'
              ? document.createElement('span')
              : null;
          },
        },
        signal: context.signal,
      });
      const queryEditor = context.modules.editors.collectionQuery({
        document,
        applied: collectionQueryOf(view),
        restored,
        onSubmit: (criteria) => {
          const next = collectionView(criteria);
          if (uiHref(next) === uiHref(view)) {
            // The same view is already presented: restart its result instead of adding an entry.
            list.refresh();
            return;
          }
          context.navigate(next);
        },
      });
      container.prepend(queryEditor.element);
      refresh.addEventListener('click', () => {
        list.refresh();
      });

      return pageHandle(list, () => ({
        ...queryEditor.capture(),
        ...changes.capture(),
        list: list.capture(),
      }));
    },
  };
}

/** The query the collection page presents for one view. */
function collectionQueryOf(view: Extract<UiView, { page: 'collection' }>): CardListCollectionQuery {
  return { text: view.query, level: view.level };
}

/** One collection view from a query; the URL then identifies the whole presented result. */
function collectionView(query: CardListCollectionQuery): UiView {
  return { page: 'collection', query: query.text, level: query.level };
}

/** Location one presented entry opens, or null when it carries no openable identity. */
function openableHref(entry: Parameters<typeof cardViewOf>[0]): string | null {
  const target = cardViewOf(entry);
  return target === null ? null : uiHref(target);
}
