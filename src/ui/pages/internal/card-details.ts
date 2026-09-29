/**
 * Card details page of the UserInterface (docs/ui/navigation.md,
 * docs/ui/pages.md#page-map, docs/user-cards.md#records-and-associations).
 *
 * One URL names the level the page presents: the card, one printing of it or one physical copy.
 * The page owns the route context and the lifetimes of its children; the level's content is
 * acquired behind the supplied CardViews and CardList capabilities — the detail view the page
 * mounts creates one list over a detail-target description, and the card level's published
 * printings are a second list instance the page composes beside it — so no path in this page reads
 * a card or copy itself (docs/ui/pages.md#interface, docs/ui/card-views.md#interface). The copy
 * level presents the account's actual copy through the private UserCards contract as the supplied
 * entry carries it, so a corrected copy is presented with the printing it now carries. The editor
 * corrects printing and language (the printing the copy references), finish and condition as one
 * change quoted by the revision the presented copy holds: a conflict or a failed change keeps the
 * unsaved draft for review and retry. After a lost response the current copy is read for review
 * while the outcome stays unknown; a saved outcome requires the change's confirmed commitment
 * (docs/ui/pages.md#page-map). The draft is page state the page keeps for its history entry, and a
 * value the draft names stays presented while its catalog data is still unavailable: the controls
 * never replace the user's intended printing, language or finish merely because the record that
 * names it has not loaded. Every provider value renders as text.
 */

import type {
  CardListDetailTarget,
  CardListEntry,
  CardListEntryCard,
} from '../../../card-list/index.js';

import type { CardViewDetail, UiCardList } from '../../card-views/index.js';
import {
  createCopyAccess,
  uiCopyReadNoticeId,
  type UiCopyDraft,
  type UiCopyEditor,
} from '../../editors/index.js';
import { uiHref, type UiPageDefinition, type UiView } from '../../navigation/index.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { reportUiFailure } from '../../shared/notices.js';
import { cardViewOf, readListState, readPageState, restoredPresentation } from './page-support.js';

/** Notice identity of this view's own level read. */
const cardDetailsNotice = 'card-details';

export function createCardDetailsPage(): UiPageDefinition {
  return {
    page: 'card',
    mount(container, context) {
      const view = context.view;
      if (view.page !== 'card') {
        return;
      }
      /** The card view this page presents; the level is fixed for the page's lifetime. */
      const cardView: Extract<UiView, { page: 'card' }> = view;
      const document = container.ownerDocument;
      const restored = readPageState(context.restored?.state);
      const status = document.createElement('p');
      status.id = 'card-details-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const content = document.createElement('div');
      content.id = 'card-details-content';
      container.append(status, content);

      const catalog = context.capabilities.catalog;
      const copies = createCopyAccess(
        context.capabilities.userCards.account(context.account.accountId),
      );
      /** The copy editor of the presented copy, kept while the level is presented. */
      let copyEditor: UiCopyEditor | null = null;
      /** The card level's printing list; the page keeps the state the list itself captured. */
      let printings: UiCardList<string> | null = null;
      /** The mounted level: its list and the content the page composed for the published entry. */
      let presentedLevel: CardViewDetail | null = null;
      /**
       * The target this route names. The page passes it to the supplied CardList binding as the
       * description of the level; it never resolves the level's records itself
       * (docs/ui/pages.md#interface).
       */
      const target: CardListDetailTarget =
        cardView.copyId !== null
          ? { kind: 'copy', copyId: cardView.copyId, cardId: cardView.cardId }
          : cardView.printingId !== null
            ? { kind: 'printing', printingId: cardView.printingId, cardId: cardView.cardId }
            : { kind: 'card', cardId: cardView.cardId };
      /**
       * The card level's published printings: the page composes the list the content of the
       * level's entry names.
       */
      const bindings = context.capabilities.cardList.account(context.account.accountId);
      /**
       * Newest load of the level the page presents. Each load fences its own results: a read a
       * later load superseded never reports, presents or replaces the content the user sees, and
       * creates no editor (docs/ui/architecture.md#asynchronous-presentation).
       */
      let loadAttempt = 0;
      const presented = Promise.withResolvers<void>();
      // A page whose presentation the shell never awaits must still not surface a rejection.
      presented.promise.catch(() => {});
      let closed = false;
      context.signal.addEventListener('abort', dispose, { once: true });

      if (context.signal.aborted) {
        dispose();
      } else {
        void render();
      }

      return {
        capture: captureState,
        presented: () => presented.promise,
        dispose,
      };

      function disposeChildren(): void {
        presentedLevel?.dispose();
        presentedLevel = null;
        disposeContent();
      }

      function disposeContent(): void {
        copyEditor?.dispose();
        copyEditor = null;
        printings?.dispose();
        printings = null;
      }

      function dispose(): void {
        if (closed) {
          return;
        }
        closed = true;
        context.signal.removeEventListener('abort', dispose);
        disposeChildren();
      }

      /**
       * State this page retains for its history entry
       * (docs/ui/architecture.md#state-ownership-and-restoration): the copy form's draft, or the
       * card level's printing list exactly as the list captured it. The page never rebuilds a list
       * snapshot from loaded rows, and a view whose list is not composed yet — still loading or a
       * failed restore — keeps the state its entry handed back instead of overwriting it with a
       * partially presented view.
       */
      function captureState(): unknown | null {
        if (cardView.copyId !== null) {
          const draft = copyEditor?.capture() ?? readCopyDraft(restored);
          return draft === null ? null : { draft };
        }
        return printings === null ? restored : { list: printings.capture() };
      }

      /**
       * Loads and presents the level the view names, or a failure the user can retry. The page
       * mounts the detail view the supplied CardViews module builds over the supplied CardList
       * capability: the view creates the level's list from the description and reports when the
       * level presented its content or failed. The page reports its own presentation once that
       * settled and, at the card level, once the retained printing window is presented again, so
       * the shell restores the entry's interaction over the presented printings
       * (docs/ui/architecture.md#state-ownership-and-restoration).
       */
      async function render(): Promise<void> {
        if (closed) {
          return;
        }
        const attempt = ++loadAttempt;
        status.textContent = 'Loading card details…';
        content.replaceChildren();
        disposeChildren();
        let level: CardViewDetail;
        try {
          level = mountLevel();
        } catch (cause) {
          if (isCurrentLoad(attempt)) {
            presentFailure(attempt, cause);
          }
          return;
        }
        if (!isCurrentLoad(attempt)) {
          level.dispose();
          return;
        }
        presentedLevel = level;
        content.replaceChildren(...level.nodes);
        try {
          await level.presented;
        } catch (cause) {
          if (!isCurrentLoad(attempt)) {
            return;
          }
          presentFailure(attempt, cause);
          return;
        }
        if (!isCurrentLoad(attempt)) {
          return;
        }
        status.textContent = '';
        context.notices.dismiss(cardDetailsNotice);
        // The copy level's editor reconciles its own read failure when the level presented the
        // copy's recorded state or its absence (docs/ui/navigation.md#error-notices).
        if (cardView.copyId !== null) {
          context.notices.dismiss(uiCopyReadNoticeId(cardView.copyId));
        }
        const restoration = levelRestoration();
        if (restoration === null) {
          presented.resolve();
          return;
        }
        try {
          await restoration;
        } catch (cause) {
          // The retained printing window could not be presented: the page reports the interrupted
          // restoration while the list keeps the failure and its retry.
          if (isCurrentLoad(attempt)) {
            presented.reject(cause);
          }
          return;
        }
        if (isCurrentLoad(attempt)) {
          presented.resolve();
        }
      }

      /** The failed level with its retry and the notice the page keeps after the view is left. */
      function presentFailure(attempt: number, cause: unknown): void {
        const problem = readMessage(
          cause,
          cardView.copyId === null
            ? 'The card details could not be loaded.'
            : 'The copy could not be loaded.',
        );
        content.replaceChildren(...failurePanel(problem));
        status.textContent = '';
        reportUiFailure(
          context.notices,
          cardView.copyId === null ? cardDetailsNotice : uiCopyReadNoticeId(cardView.copyId),
          problem,
          {
            label: cardView.copyId === null ? 'Load the details again' : 'Load the copy again',
            run: () => {
              void render();
            },
          },
        );
        if (isCurrentLoad(attempt)) {
          presented.reject(cause);
        }
      }

      /**
       * Mounts the level's detail view over the supplied capabilities. The view creates the list
       * from the description, renders the identity the list published and composes the nodes the
       * page supplies for the entry, so the page describes the level instead of reading it.
       */
      function mountLevel(): CardViewDetail {
        return context.modules.cardViews.detail({
          document,
          create: context.capabilities.cardList.create,
          source: bindings.detailTarget(target),
          context: target,
          accountId: context.account.accountId,
          pageSize: UI_LIMITS.printingPage,
          identity: cardView.copyId !== null ? 'none' : printingTarget() ? 'printing' : 'card',
          fragments: { images: bindings.printingImages() },
          content: (entry) => levelContent(entry),
          navigation: (entry) => levelNavigation(entry),
          signal: context.signal,
        });
      }

      /** Whether this route's level is one printing of a card rather than the card itself. */
      function printingTarget(): boolean {
        return cardView.printingId !== null && cardView.copyId === null;
      }

      /** The nodes the page composes for the published level entry. */
      function levelContent(entry: CardListEntry): readonly Node[] {
        disposeContent();
        if (entry.detail?.absent != null) {
          return [];
        }
        switch (entry.target.kind) {
          case 'card':
            return cardLevelContent(entry);
          case 'copy':
            return copyLevelContent(entry);
          default:
            return [];
        }
      }

      /** Navigation of the presented level, as the page composes it around its children. */
      function levelNavigation(entry: CardListEntry): readonly Node[] {
        const card = entry.basic?.card ?? null;
        switch (target.kind) {
          case 'card':
            return [collectionLinks(card)];
          case 'printing':
            return [
              navigation([
                link('printing-card-link', viewOfCard(cardView.cardId, null, null), 'Card details'),
                collectionLink(card, 'copy'),
              ]),
            ];
          case 'copy':
            return [];
        }
      }

      /**
       * The restoration of the level's own child list, or null when this visit restored none: the
       * card level reports its presentation after the retained printing window is presented again
       * (docs/ui/architecture.md#state-ownership-and-restoration).
       */
      function levelRestoration(): Promise<void> | null {
        return printings === null ? null : restoredPresentation(printings);
      }

      /**
       * The copy level's editor and its navigation. The detail view publishes the entry the level
       * read, so the page seeds the editor from the copy the list read and never reads it itself
       * (docs/ui/pages.md#interface).
       */
      function copyLevelContent(entry: CardListEntry): readonly Node[] {
        const copy = entry.detail?.copy ?? null;
        if (copy === null) {
          return [];
        }
        const card = entry.basic?.card ?? null;
        const cardId = card?.cardId ?? cardView.cardId;
        const editor = context.modules.editors.copy({
          document,
          access: copies,
          catalog,
          cardList: context.capabilities.cardList,
          cardViews: context.modules.cardViews,
          accountId: context.account.accountId,
          copy,
          card,
          printing: entry.basic?.printing ?? null,
          notices: context.notices,
          restored: restored?.draft,
          signal: context.signal,
          printingHref: (saved) => uiHref(viewOfCard(cardId, saved.printingId, null)),
        });
        copyEditor = editor;
        return [
          editor.element,
          navigation([
            editor.printingLink,
            link('copy-card-link', viewOfCard(cardId, null, null), 'Card details'),
          ]),
        ];
      }

      /** The card level's content: the playable printings list and the card-level navigation. */
      function cardLevelContent(entry: CardListEntry): readonly Node[] {
        const card = entry.basic?.card ?? null;
        if (card === null) {
          return [];
        }
        const host = document.createElement('div');
        host.id = 'card-printings';
        const name = card.name;
        const list = context.modules.cardViews.list<string>({
          container: host,
          create: context.capabilities.cardList.create,
          source: bindings.cardPrintings({ cardId: card.cardId, name }),
          context: card.cardId,
          accountId: context.account.accountId,
          pageSize: UI_LIMITS.printingPage,
          restored: readListState<string>(restored),
          presentation: context.modules.cardViews.openEntries({
            document,
            idPrefix: 'card-printing',
            href: (printingEntry) => {
              const openTarget = cardViewOf(printingEntry);
              return openTarget === null ? null : uiHref(openTarget);
            },
          }),
          signal: context.signal,
        });
        printings = list;
        return [line('card-printings-label', 'Published printings'), host];
      }

      /**
       * Whether one load attempt is still the one the page presents
       * (docs/ui/architecture.md#asynchronous-presentation).
       */
      function isCurrentLoad(attempt: number): boolean {
        return !closed && attempt === loadAttempt;
      }

      /** The card level's retryable failure of the level read. */
      function failurePanel(problem: string): readonly Node[] {
        const hint = document.createElement('p');
        hint.id = 'card-details-failure';
        hint.textContent = problem;
        const retry = button('card-details-retry', 'Retry');
        retry.addEventListener('click', () => {
          void render();
        });
        return [hint, retry];
      }

      /** The card level's navigation: search the collection for this card. */
      function collectionLinks(card: CardListEntryCard | null): Node {
        return navigation([collectionLink(card, 'printing'), collectionLink(card, 'copy')]);
      }

      function collectionLink(
        card: CardListEntryCard | null,
        level: 'printing' | 'copy',
      ): HTMLAnchorElement {
        const anchor = link(
          `collection-link-${level}`,
          { page: 'collection', query: card?.name ?? '', level },
          level === 'printing'
            ? 'Search your collection for this card’s printings'
            : 'Search your collection for this card’s copies',
        );
        return anchor;
      }

      function viewOfCard(
        cardId: string,
        printingId: string | null,
        copyId: string | null,
      ): UiView {
        return { page: 'card', cardId, printingId, copyId };
      }

      function line(id: string, text: string): HTMLParagraphElement {
        const element = document.createElement('p');
        element.id = id;
        element.textContent = text;
        return element;
      }

      function button(id: string, text: string): HTMLButtonElement {
        const element = document.createElement('button');
        element.type = 'button';
        element.id = id;
        element.textContent = text;
        return element;
      }

      function link(id: string, view: UiView, text: string): HTMLAnchorElement {
        const element = document.createElement('a');
        element.id = id;
        element.href = uiHref(view);
        element.textContent = text;
        return element;
      }

      function navigation(links: readonly HTMLAnchorElement[]): HTMLElement {
        const element = document.createElement('nav');
        element.id = 'card-details-navigation';
        element.setAttribute('aria-label', 'Card levels');
        element.append(...links);
        return element;
      }
    },
  };
}

/** The copy draft a history entry kept, or null when this visit restored none. */
function readCopyDraft(state: Readonly<Record<string, unknown>> | null): UiCopyDraft | null {
  const draft = state?.draft;
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    return null;
  }
  const values = draft as Readonly<Record<string, unknown>>;
  const printingId = values.printingId;
  const finish = values.finish;
  const condition = values.condition;
  if (
    typeof printingId !== 'string' ||
    typeof finish !== 'string' ||
    typeof condition !== 'string'
  ) {
    return null;
  }
  return { printingId, finish, condition };
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
