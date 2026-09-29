/**
 * Card details page of the UserInterface (docs/ui/navigation.md,
 * docs/ui/pages.md#page-map, docs/user-cards.md#records-and-associations).
 *
 * One URL names the level the page presents: the card, one printing of it or one physical copy.
 * The card level presents the published card and its published printings through the list boundary,
 * whose bounded window, continuation, failure and restoration belong to the list and travel with
 * the page's own state (docs/card-list.md,
 * docs/ui/architecture.md#state-ownership-and-restoration). The printing level presents one
 * published version of the card. The copy level reads the account's actual copy through the private
 * UserCards contract and resolves the printing it references, so a corrected copy is presented with
 * the printing it now carries. The copy level corrects printing and language (the printing the copy
 * references), finish and condition as one change quoted by the revision the page read: a conflict
 * or a failed change keeps the unsaved draft for review and retry. After a lost response the current
 * copy is read for review while the outcome stays unknown; a saved outcome requires the change's
 * confirmed commitment (docs/ui/pages.md#page-map). The draft is page state the page
 * keeps for its history entry, and a value the draft names stays presented while its catalog data is
 * still unavailable: the controls never replace the user's intended printing, language or finish
 * merely because the record that names it has not loaded. Every provider value renders as text.
 */

import type { CardRecord, Catalog, PrintingRecord } from '../../../catalog/index.js';

import type { UiCardList } from '../../card-views/index.js';
import {
  createCopyAccess,
  uiCopyReadNoticeId,
  type UiCopyDraft,
  type UiCopyEditor,
  type UiCopyRead,
} from '../../editors/index.js';
import { uiHref, type UiPageDefinition, type UiView } from '../../navigation/index.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { reportUiFailure } from '../../shared/notices.js';
import { cardViewOf, readListState, readPageState, restoredPresentation } from './page-support.js';

/** What one level of the page presents: its content and the restoration its own list reports. */
interface UiLevelPresentation {
  readonly nodes: readonly Node[];
  /** Presentation of the level's retained list, or null when the level composes none. */
  readonly restoration: Promise<void> | null;
}

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
      context.signal.addEventListener(
        'abort',
        () => {
          closed = true;
        },
        { once: true },
      );

      void render();

      return {
        capture: captureState,
        presented: () => presented.promise,
      };

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
       * reports its presentation once the level's own work settled: the card level reports after
       * the retained printing window is presented again, so the shell restores the entry's
       * interaction over the presented printings
       * (docs/ui/architecture.md#state-ownership-and-restoration).
       */
      async function render(): Promise<void> {
        const attempt = ++loadAttempt;
        status.textContent = 'Loading card details…';
        content.replaceChildren();
        copyEditor?.dispose();
        copyEditor = null;
        printings?.dispose();
        printings = null;
        let level: UiLevelPresentation | null;
        try {
          level =
            cardView.copyId !== null
              ? await copyLevel(cardView.copyId, attempt)
              : cardView.printingId !== null
                ? await printingLevel(cardView.printingId, attempt)
                : await cardLevel(attempt);
          if (!isCurrentLoad(attempt) || level === null) {
            return;
          }
          content.replaceChildren(...level.nodes);
          status.textContent = '';
          context.notices.dismiss(cardDetailsNotice);
        } catch (cause) {
          if (!isCurrentLoad(attempt)) {
            return;
          }
          const problem = readMessage(cause, 'The card details could not be loaded.');
          content.replaceChildren(...failurePanel(problem));
          status.textContent = '';
          presented.reject(cause);
          return;
        }
        if (level.restoration === null) {
          presented.resolve();
          return;
        }
        try {
          await level.restoration;
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

      /**
       * Whether one load attempt is still the one the page presents
       * (docs/ui/architecture.md#asynchronous-presentation).
       */
      function isCurrentLoad(attempt: number): boolean {
        return !closed && attempt === loadAttempt;
      }

      /**
       * Reads the published records of the presented level. A failed read of the level is a
       * service failure with no field to hold it: the page reports it under the identity of its
       * own level reads, whose action loads the level again, and keeps presenting the failure
       * beside the retry while the notice keeps it visible after the view is left
       * (docs/ui/navigation.md#error-notices). A load a newer attempt superseded reports nothing.
       */
      async function readLevel<T>(attempt: number, read: () => Promise<T>): Promise<T> {
        try {
          return await read();
        } catch (cause) {
          if (isCurrentLoad(attempt)) {
            reportUiFailure(
              context.notices,
              cardDetailsNotice,
              readMessage(cause, 'The card details could not be loaded.'),
              {
                label: 'Load the details again',
                run: () => {
                  void render();
                },
              },
            );
          }
          throw cause;
        }
      }

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

      /** The card level: the playable identity and its published printings. */
      async function cardLevel(attempt: number): Promise<UiLevelPresentation> {
        const card = await readLevel(attempt, () => resolveCard(catalog, cardView.cardId));
        return card === null
          ? { nodes: [missingPanel('The catalog does not publish this card.')], restoration: null }
          : cardContent(card);
      }

      /** The printing level: one published version of one card. */
      async function printingLevel(
        printingId: string,
        attempt: number,
      ): Promise<UiLevelPresentation> {
        const resolution = await readLevel(attempt, () =>
          catalog.resolve([{ kind: 'printing', printingId }]),
        );
        const printing = resolution.printings.get(printingId) ?? null;
        if (printing === null) {
          return {
            nodes: [missingPanel('The catalog does not publish this printing.')],
            restoration: null,
          };
        }
        const card = await readLevel(attempt, () => resolveCard(catalog, printing.cardId));
        return card === null
          ? {
              nodes: [missingPanel('The catalog does not publish the card of this printing.')],
              restoration: null,
            }
          : { nodes: printingContent(card, printing), restoration: null };
      }

      /**
       * The physical-copy level: the account's actual copy, its current attributes and the change
       * that corrects printing and language, finish and condition.
       */
      async function copyLevel(
        copyId: string,
        attempt: number,
      ): Promise<UiLevelPresentation | null> {
        const readNotice = uiCopyReadNoticeId(copyId);
        let read: UiCopyRead;
        try {
          read = await copies.read([copyId], context.signal);
        } catch (cause) {
          if (isCurrentLoad(attempt)) {
            // Reading the copy is a service failure with no field to hold it: the notice keeps the
            // failure visible after the view is left, with the same explicit recovery
            // (docs/ui/navigation.md#error-notices).
            reportUiFailure(
              context.notices,
              readNotice,
              readMessage(cause, 'The copy could not be loaded.'),
              {
                label: 'Load the copy again',
                run: () => {
                  void render();
                },
              },
            );
          }
          throw cause;
        }
        if (!isCurrentLoad(attempt)) {
          // A later load of the level owns the page: this read reports nothing and presents
          // nothing.
          return null;
        }
        // The read established the copy's current state — its recorded attributes or its absence —
        // so it reconciles the failure of an earlier read, including one an editor presented
        // before this page replaced it (docs/ui/navigation.md#error-notices).
        context.notices.dismiss(readNotice);
        const copy = read.copies[0] ?? null;
        if (copy === null) {
          return {
            nodes: [missingPanel('This account has no physical copy with that identity.')],
            restoration: null,
          };
        }
        const resolution = await readLevel(attempt, () =>
          catalog.resolve([{ kind: 'printing', printingId: copy.printingId }]),
        );
        const printing = resolution.printings.get(copy.printingId) ?? null;
        const cardId = printing?.cardId ?? cardView.cardId;
        const card = await readLevel(attempt, () => resolveCard(catalog, cardId));
        if (!isCurrentLoad(attempt)) {
          // The read of the copy and its catalog resolution belong to a load the page replaced.
          return null;
        }
        const editor = context.modules.editors.copy({
          document,
          access: copies,
          catalog,
          cardList: context.capabilities.cardList,
          cardViews: context.modules.cardViews,
          accountId: context.account.accountId,
          copy,
          card,
          printing,
          notices: context.notices,
          restored: restored?.draft,
          signal: context.signal,
          printingHref: (saved) => uiHref(viewOfCard(cardId, saved.printingId, null)),
        });
        copyEditor = editor;
        return {
          nodes: [
            editor.element,
            navigation([
              editor.printingLink,
              link('copy-card-link', viewOfCard(cardId, null, null), 'Card details'),
            ]),
          ],
          restoration: null,
        };
      }

      /**
       * The card level's content: the published printings are one bounded list over the Catalog
       * contract, so its window, continuation, failure and retry stay the list's own business and
       * the page keeps the state it captured for the history entry (docs/card-list.md).
       */
      function cardContent(card: CardRecord): UiLevelPresentation {
        const host = document.createElement('div');
        host.id = 'card-printings';
        const bindings = context.capabilities.cardList.account(context.account.accountId);
        const list = context.modules.cardViews.list({
          container: host,
          create: context.capabilities.cardList.create,
          source: bindings.cardPrintings(card),
          context: card.cardId,
          accountId: context.account.accountId,
          pageSize: UI_LIMITS.printingPage,
          restored: readListState<string>(restored),
          presentation: context.modules.cardViews.openEntries({
            document,
            idPrefix: 'card-printing',
            href: (entry) => {
              const target = cardViewOf(entry);
              return target === null ? null : uiHref(target);
            },
          }),
          signal: context.signal,
        });
        printings = list;
        const detail = context.modules.cardViews.detail({
          document,
          card,
          printing: null,
          content: [line('card-printings-label', 'Published printings'), host],
          navigation: [collectionLinks(card)],
        });
        return {
          nodes: detail.nodes,
          restoration: restoredPresentation(list),
        };
      }

      function printingContent(card: CardRecord, printing: PrintingRecord): readonly Node[] {
        return context.modules.cardViews.detail({
          document,
          card,
          printing,
          navigation: [navigation([cardLink(card), collectionLink(card, 'copy')])],
        }).nodes;
      }

      function collectionLinks(card: CardRecord): Node {
        return navigation([collectionLink(card, 'printing'), collectionLink(card, 'copy')]);
      }

      function collectionLink(
        card: CardRecord | null,
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

      function cardLink(card: CardRecord): HTMLAnchorElement {
        return link('printing-card-link', viewOfCard(card.cardId, null, null), 'Card details');
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

      function missingPanel(message: string): HTMLParagraphElement {
        const element = document.createElement('p');
        element.id = 'card-details-missing';
        element.textContent = message;
        return element;
      }
    },
  };
}

/** Resolves one card, or null when the published revision does not carry it. */
async function resolveCard(catalog: Catalog, cardId: string): Promise<CardRecord | null> {
  const resolution = await catalog.resolve([{ kind: 'card', cardId }]);
  return resolution.cards.get(cardId) ?? null;
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
