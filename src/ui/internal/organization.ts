/**
 * Organization pages of the UserInterface (docs/ui/pages.md#page-map, docs/ui/editors.md).
 *
 * The tags page composes the tag list editor: the account's tags in a bounded window with the
 * controls that create and rename them. The tag view composes the tag view editor: one tag's
 * associations as a bounded CardList, its editable label and the search that adds members, so a
 * wishlist can name a card or one exact printing and a location can take a copy. The pages own
 * layout and route context; drafts, provider revisions, conflicts and operation presentation stay
 * with the editors and the provider-owned operations they present
 * (docs/ui/architecture.md#modules-and-composition). Every provider value renders as text.
 */

import { createTagAccess } from '../editors/index.js';
import type { UiPageDefinition } from './pages.js';
import { readPageState } from './page-support.js';
import { uiHref } from './routes.js';

/** The organization views: the account's tags and one tag's deck, wishlist, location or grouping. */
export function createOrganizationPages(): readonly UiPageDefinition[] {
  return [tagsPage(), tagViewPage()];
}

/** Tags page of the account: the tag list editor over the private UserCards contract. */
function tagsPage(): UiPageDefinition {
  return {
    page: 'tags',
    mount(container, context) {
      const editor = context.modules.editors.tagList({
        document: container.ownerDocument,
        access: createTagAccess(context.capabilities.userCards.account(context.account.accountId)),
        cardList: context.capabilities.cardList,
        cardViews: context.modules.cardViews,
        catalog: context.capabilities.catalog,
        accountId: context.account.accountId,
        dialogs: context.dialogs,
        signal: context.signal,
        restored: readPageState(context.restored?.state),
        tagHref: (tag) => uiHref({ page: 'tag', tagId: tag.tagId }),
      });
      container.append(...editor.nodes);
      return {
        capture: () => editor.capture(),
        dispose: () => editor.dispose(),
      };
    },
  };
}

/** The tag view: one tag's associations, its editable label and the search that adds members. */
function tagViewPage(): UiPageDefinition {
  return {
    page: 'tag',
    mount(container, context) {
      const view = context.view;
      if (view.page !== 'tag') {
        return;
      }
      const editor = context.modules.editors.tagView({
        document: container.ownerDocument,
        access: createTagAccess(context.capabilities.userCards.account(context.account.accountId)),
        cardList: context.capabilities.cardList,
        cardViews: context.modules.cardViews,
        catalog: context.capabilities.catalog,
        accountId: context.account.accountId,
        dialogs: context.dialogs,
        signal: context.signal,
        tagId: view.tagId,
        restored: readPageState(context.restored?.state),
        backHref: uiHref({ page: 'tags' }),
      });
      container.append(...editor.nodes);
      return {
        capture: () => editor.capture(),
        presented: () => editor.presentation(),
        dispose: () => editor.dispose(),
      };
    },
  };
}
