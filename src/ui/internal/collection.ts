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

import { createCardListView } from './card-list.js';
import {
  copyChangeTool,
  createCopyAccess,
  uiCopyConditions,
  type UiCopyChange,
} from './copy-edits.js';
import { createCardDetailsPage } from './card-details.js';
import { UI_LIMITS } from './limits.js';
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
import type { UiPageDefinition } from './pages.js';
import {
  readUiCatalogFinish,
  readUiCollectionLevel,
  uiCatalogFinishes,
  uiCollectionLevels,
  uiFinishLabel,
  uiHref,
  type UiView,
} from './routes.js';

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
      const input = searchInput(document, 'collection-search');
      input.value = view.query;
      const level = collectionLevelSelect(document);
      level.id = 'collection-level';
      level.value = view.level;
      const form = searchForm(
        document,
        input,
        [controlLabel(document, 'Level', level)],
        'Search collection',
      );
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.id = 'collection-refresh';
      refresh.textContent = 'Refresh collection';

      const changes = copyChangesFieldset(document);
      const heading = document.createElement('h2');
      heading.textContent = 'Your collection';
      const listHost = document.createElement('div');
      listHost.id = 'collection-results';
      container.append(form, refresh, changes.fieldset, heading, listHost);

      const account = context.capabilities.userCards.account(context.account.accountId);
      const copies = createCopyAccess(account);
      const bindings = context.capabilities.cardList.account(context.account.accountId);
      const list = createCardListView<CardListCollectionQuery>({
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
        tools: [
          copyChangeTool({
            id: 'apply-finish',
            label: 'Apply finish',
            access: copies,
            change: () => readFinishChange(changes.finish),
            guidance: 'Choose the finish to apply to the selected copies.',
          }),
          copyChangeTool({
            id: 'apply-condition',
            label: 'Apply condition',
            access: copies,
            change: () => readConditionChange(changes.condition),
            guidance: 'Choose the condition to apply to the selected copies.',
          }),
        ],
        presentation: {
          ...openEntryPresentation(document, 'collection-entry'),
          renderFragment(kind, entry) {
            // Only copies offer bulk changes; other entries present no tool availability at all.
            return kind === 'tools' && entry.target.kind !== 'copy'
              ? document.createElement('span')
              : null;
          },
        },
        signal: context.signal,
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const next = collectionView({
          text: input.value.trim(),
          level: readUiCollectionLevel(level.value),
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
        level.value = readUiCollectionLevel(restored.level);
      }
      if (typeof restored?.finish === 'string') {
        changes.finish.value = restored.finish;
      }
      if (typeof restored?.condition === 'string') {
        changes.condition.value = restored.condition;
      }
      return pageHandle(list, () => ({
        query: input.value,
        level: level.value,
        finish: changes.finish.value,
        condition: changes.condition.value,
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

/** Result level control of the collection page. */
function collectionLevelSelect(document: Document): HTMLSelectElement {
  return selectControl(
    document,
    uiCollectionLevels.map((level) => ({
      value: level,
      label: level === 'card' ? 'Cards' : level === 'printing' ? 'Printings' : 'Physical copies',
    })),
    'card',
  );
}

/** The controls whose values the bulk copy changes apply, beside the list that acts on them. */
function copyChangesFieldset(document: Document): {
  readonly fieldset: HTMLFieldSetElement;
  readonly finish: HTMLSelectElement;
  readonly condition: HTMLSelectElement;
} {
  const fieldset = document.createElement('fieldset');
  fieldset.id = 'collection-changes';
  const legend = document.createElement('legend');
  legend.textContent = 'Bulk copy changes';
  const hint = document.createElement('p');
  hint.textContent =
    'Select physical copies in the list, choose a value and apply it to the whole selection.';
  const finish = document.createElement('select');
  finish.id = 'collection-finish';
  finish.append(placeholderOption(document, 'Choose finish'), ...finishOptions(document));
  const condition = document.createElement('select');
  condition.id = 'collection-condition';
  condition.append(
    placeholderOption(document, 'Choose condition'),
    valueOption(document, 'unknown', 'Unknown'),
    ...uiCopyConditions.map((condition) =>
      valueOption(document, condition, conditionName(condition)),
    ),
  );
  fieldset.append(
    legend,
    hint,
    controlLabel(document, 'Finish to apply', finish),
    controlLabel(document, 'Condition to apply', condition),
  );
  return { fieldset, finish, condition };
}

/** The finish one bulk control names, or null while it names none. */
function readFinishChange(select: HTMLSelectElement): UiCopyChange | null {
  const finish = readUiCatalogFinish(select.value);
  return finish === null ? null : { finish };
}

/** The condition one bulk control names, or null while it names none. */
function readConditionChange(select: HTMLSelectElement): UiCopyChange | null {
  switch (select.value) {
    case '':
      return null;
    case 'unknown':
      return { condition: null };
    default:
      return uiCopyConditions.includes(select.value as (typeof uiCopyConditions)[number])
        ? { condition: select.value as (typeof uiCopyConditions)[number] }
        : null;
  }
}

/** Whether the presented entries offer the bulk copy changes; only copies can be changed. */
function placeholderOption(document: Document, label: string): HTMLOptionElement {
  return valueOption(document, '', label);
}

function finishOptions(document: Document): HTMLOptionElement[] {
  return uiCatalogFinishes.map((finish) => valueOption(document, finish, uiFinishLabel(finish)));
}

function valueOption(document: Document, value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

/** Display name of one condition code. */
function conditionName(condition: (typeof uiCopyConditions)[number]): string {
  switch (condition) {
    case 'NM':
      return 'Near mint';
    case 'LP':
      return 'Lightly played';
    case 'MP':
      return 'Moderately played';
    case 'HP':
      return 'Heavily played';
    case 'DMG':
      return 'Damaged';
  }
}
