/**
 * Card details page of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations).
 *
 * One URL names the level the page presents: the card, one printing of it or one physical copy.
 * The card level presents the published card and its published printings through the list boundary,
 * whose bounded window, continuation, failure and restoration belong to the list and travel with
 * the page's own state (docs/user-interface.md#cardlist,
 * docs/user-interface.md#state-ownership-and-restoration). The printing level presents one
 * published version of the card. The copy level reads the account's actual copy through the private
 * UserCards contract and resolves the printing it references, so a corrected copy is presented with
 * the printing it now carries. The copy level corrects printing and language (the printing the copy
 * references), finish and condition as one change quoted by the revision the page read: a conflict
 * or a failed change keeps the unsaved draft for review and retry. After a lost response the current
 * copy is read for review while the outcome stays unknown; a saved outcome requires the change's
 * confirmed commitment (docs/user-interface.md#browsing-and-organization). The draft is page state the page
 * keeps for its history entry, and a value the draft names stays presented while its catalog data is
 * still unavailable: the controls never replace the user's intended printing, language or finish
 * merely because the record that names it has not loaded. Every provider value renders as text.
 */

import type {
  CardPrintingsPage,
  CardRecord,
  Catalog,
  Finish,
  PrintingRecord,
} from '../../catalog/index.js';
import { readFailureCode } from '../../card-list/index.js';
import type { PhysicalCopy } from '../../usercards/index.js';

import { createCardListView, type UiCardList } from '../card-views/index.js';
import {
  correctCopy,
  createCopyAccess,
  uiCopyConditions,
  type UiCopyCorrection,
} from '../editors/index.js';
import { UI_LIMITS } from '../shared/limits.js';
import {
  controlLabel,
  openEntryPresentation,
  readListState,
  readPageState,
  restoredPresentation,
} from './page-support.js';
import type { UiPageDefinition } from './pages.js';
import { uiCatalogFinishes, uiFinishLabel, uiHref, type UiView } from './routes.js';

/**
 * The copy form's values as the page keeps them: the language the printing choices are narrowed
 * to, the printing the copy is corrected to, its finish and its condition (`unknown` or a code).
 */
interface UiCopyDraft {
  readonly language: string;
  readonly printingId: string;
  readonly finish: string;
  readonly condition: string;
}

/**
 * One card's published printings as the copy form loaded them so far: the bounded window the form
 * offers, the continuation of the page after it, whether a request is in flight and the failure of
 * the last request. A failure is not the end of the list.
 */
interface UiPrintingsWindow {
  readonly printings: Map<string, PrintingRecord>;
  continuation: string | null;
  loading: boolean;
  error: string | null;
}

/** Outcome of one read of the corrected copy: the recorded copy, its absence or a failed read. */
type UiCopyReadResult =
  | { readonly work: number; readonly status: 'read'; readonly copy: PhysicalCopy }
  | { readonly work: number; readonly status: 'missing' }
  | { readonly work: number; readonly status: 'failed'; readonly message: string };

/** What one level of the page presents: its content and the restoration its own list reports. */
interface UiLevelPresentation {
  readonly nodes: readonly Node[];
  /** Presentation of the level's retained list, or null when the level composes none. */
  readonly restoration: Promise<void> | null;
}

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
      /** The copy form's state, kept whether or not the form is presented at this moment. */
      let draft = readCopyDraft(restored);
      /** The card level's printing list; the page keeps the state the list itself captured. */
      let printings: UiCardList<string> | null = null;
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
       * (docs/user-interface.md#state-ownership-and-restoration): the copy form's draft, or the
       * card level's printing list exactly as the list captured it. The page never rebuilds a list
       * snapshot from loaded rows, and a view whose list is not composed yet — still loading or a
       * failed restore — keeps the state its entry handed back instead of overwriting it with a
       * partially presented view.
       */
      function captureState(): unknown | null {
        if (cardView.copyId !== null) {
          return draft === null ? null : { draft };
        }
        return printings === null ? restored : { list: printings.capture() };
      }

      /**
       * Loads and presents the level the view names, or a failure the user can retry. The page
       * reports its presentation once the level's own work settled: the card level reports after
       * the retained printing window is presented again, so the shell restores the entry's
       * interaction over the presented printings
       * (docs/user-interface.md#state-ownership-and-restoration).
       */
      async function render(): Promise<void> {
        status.textContent = 'Loading card details…';
        content.replaceChildren();
        printings?.dispose();
        printings = null;
        let level: UiLevelPresentation;
        try {
          level =
            cardView.copyId !== null
              ? await copyLevel(cardView.copyId)
              : cardView.printingId !== null
                ? await printingLevel(cardView.printingId)
                : await cardLevel();
          if (closed) {
            return;
          }
          content.replaceChildren(...level.nodes);
          status.textContent = '';
        } catch (cause) {
          if (closed) {
            return;
          }
          content.replaceChildren(...failurePanel(cause));
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
          if (!closed) {
            presented.reject(cause);
          }
          return;
        }
        if (!closed) {
          presented.resolve();
        }
      }

      function failurePanel(cause: unknown): readonly Node[] {
        const hint = document.createElement('p');
        hint.id = 'card-details-failure';
        hint.textContent = readMessage(cause, 'The card details could not be loaded.');
        const retry = button('card-details-retry', 'Retry');
        retry.addEventListener('click', () => {
          void render();
        });
        return [hint, retry];
      }

      /** The card level: the playable identity and its published printings. */
      async function cardLevel(): Promise<UiLevelPresentation> {
        const card = await resolveCard(catalog, cardView.cardId);
        return card === null
          ? { nodes: [missingPanel('The catalog does not publish this card.')], restoration: null }
          : cardContent(card);
      }

      /** The printing level: one published version of one card. */
      async function printingLevel(printingId: string): Promise<UiLevelPresentation> {
        const resolution = await catalog.resolve([{ kind: 'printing', printingId }]);
        const printing = resolution.printings.get(printingId) ?? null;
        if (printing === null) {
          return {
            nodes: [missingPanel('The catalog does not publish this printing.')],
            restoration: null,
          };
        }
        const card = await resolveCard(catalog, printing.cardId);
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
      async function copyLevel(copyId: string): Promise<UiLevelPresentation> {
        const read = await copies.read([copyId], context.signal);
        const copy = read.copies[0] ?? null;
        if (copy === null) {
          return {
            nodes: [missingPanel('This account has no physical copy with that identity.')],
            restoration: null,
          };
        }
        const resolution = await catalog.resolve([
          { kind: 'printing', printingId: copy.printingId },
        ]);
        const printing = resolution.printings.get(copy.printingId) ?? null;
        const card = await resolveCard(catalog, printing?.cardId ?? cardView.cardId);
        return { nodes: copyContent(copy, card, printing), restoration: null };
      }

      /**
       * The card level's content: the published printings are one bounded list over the Catalog
       * contract, so its window, continuation, failure and retry stay the list's own business and
       * the page keeps the state it captured for the history entry (docs/user-interface.md#cardlist).
       */
      function cardContent(card: CardRecord): UiLevelPresentation {
        const host = document.createElement('div');
        host.id = 'card-printings';
        const bindings = context.capabilities.cardList.account(context.account.accountId);
        const list = createCardListView({
          container: host,
          create: context.capabilities.cardList.create,
          source: bindings.cardPrintings(card),
          context: card.cardId,
          accountId: context.account.accountId,
          pageSize: UI_LIMITS.printingPage,
          restored: readListState<string>(restored),
          presentation: openEntryPresentation(document, 'card-printing'),
          signal: context.signal,
        });
        printings = list;
        return {
          nodes: [
            heading('card-name', card.name),
            line('card-type', card.typeLine ?? 'Type not published'),
            line('card-text', card.rulesText ?? 'No rules text published.'),
            line('card-printings-label', 'Published printings'),
            host,
            collectionLinks(card),
          ],
          restoration: restoredPresentation(list),
        };
      }

      function printingContent(card: CardRecord, printing: PrintingRecord): readonly Node[] {
        const nodes: Node[] = [
          heading('printing-name', card.name),
          line('printing-line', printingLine(printing)),
          line(
            'printing-finishes',
            printing.finishes.length === 0
              ? 'No finish published'
              : `Finishes: ${printing.finishes.join(', ')}`,
          ),
        ];
        const image = printingImage(printing);
        if (image !== null) {
          nodes.push(image);
        }
        nodes.push(navigation([cardLink(card), collectionLink(card, 'copy')]));
        return nodes;
      }

      /**
       * The copy's stored attributes beside the change being edited. The stored values are
       * presented from the copy the page read; the form keeps the unsaved draft, and a change that
       * committed replaces the stored values without touching the draft.
       */
      function copyContent(
        copy: PhysicalCopy,
        card: CardRecord | null,
        printing: PrintingRecord | null,
      ): readonly Node[] {
        let saved = copy;
        /**
         * Sequence of the newest copy-state work of this form: feedback of a request a later
         * operation superseded is not presented, so an obsolete reload never overwrites the
         * outcome of a save that followed it.
         */
        let work = 0;
        const cardId = printing?.cardId ?? cardView.cardId;
        const window: UiPrintingsWindow = {
          printings: new Map(printing === null ? [] : [[printing.printingId, printing]]),
          continuation: null,
          loading: false,
          error: null,
        };
        const savedLine = line('copy-saved', '');
        const copyStatus = line('copy-status', '');
        copyStatus.setAttribute('role', 'status');
        copyStatus.setAttribute('aria-live', 'polite');
        const printingsStatus = line('copy-printings-status', '');
        printingsStatus.setAttribute('role', 'status');
        printingsStatus.setAttribute('aria-live', 'polite');
        const language = document.createElement('select');
        language.id = 'copy-language';
        const printingChoice = document.createElement('select');
        printingChoice.id = 'copy-printing-choice';
        const finish = document.createElement('select');
        finish.id = 'copy-finish-choice';
        const condition = document.createElement('select');
        condition.id = 'copy-condition-choice';
        const more = button('copy-printings-more', 'More printings');
        const save = document.createElement('button');
        save.type = 'submit';
        save.id = 'copy-save';
        save.textContent = 'Save changes';
        const reload = button('copy-reload', 'Reload copy');
        const form = document.createElement('form');
        form.id = 'copy-form';
        form.append(
          controlLabel(document, 'Language', language),
          controlLabel(document, 'Printing', printingChoice),
          controlLabel(document, 'Finish', finish),
          controlLabel(document, 'Condition', condition),
          more,
          save,
          ' ',
          reload,
        );
        const printingLink = link(
          'copy-printing-link',
          viewOfCard(cardId, saved.printingId, null),
          'Printing details',
        );
        const section = document.createElement('section');
        section.append(
          heading('copy-name', card?.name ?? 'Physical copy'),
          savedLine,
          line('copy-id', `Copy ${copy.copyId}`),
          form,
          copyStatus,
          printingsStatus,
        );
        paintSaved();
        paint();
        form.addEventListener('change', () => {
          draft = readForm();
          paint();
        });
        more.addEventListener('click', () => {
          void loadMorePrintings();
        });
        reload.addEventListener('click', () => {
          void reloadCopy();
        });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void saveCopy();
        });
        if (card !== null) {
          // The published printings are an offer: the copy's own printing stays correctable even
          // when the catalog list cannot be read.
          void loadMorePrintings();
        }
        return [
          section,
          navigation([
            printingLink,
            link('copy-card-link', viewOfCard(cardId, null, null), 'Card details'),
          ]),
        ];

        /**
         * Presents the draft in the controls. The draft keeps the intended values: a printing,
         * language or finish whose catalog data has not loaded stays the presented choice, named by
         * its identity until its record arrives, and the controls fall back only for a value outside
         * the published vocabulary. The effective values become the draft.
         */
        function paint(): void {
          const wanted = draft ?? {
            language: '',
            printingId: saved.printingId,
            finish: saved.finish,
            condition: saved.condition ?? 'unknown',
          };
          const languages = new Set<string>();
          for (const known of window.printings.values()) {
            languages.add(known.language);
          }
          if (printing !== null) {
            languages.add(printing.language);
          }
          if (wanted.language.length > 0) {
            // The intended language stays selectable while the printing that names it is loading.
            languages.add(wanted.language);
          }
          language.replaceChildren(
            option(document, '', 'Any language'),
            ...[...languages]
              .filter((code) => code.length > 0)
              .sort()
              .map((code) => option(document, code, code)),
          );
          const chosenLanguage = wanted.language;
          language.value = chosenLanguage;

          const wantedPrintingId =
            wanted.printingId.length > 0 ? wanted.printingId : saved.printingId;
          const choices = [...window.printings.values()].filter(
            (known) => chosenLanguage === '' || known.language === chosenLanguage,
          );
          const chosenPrinting = window.printings.get(wantedPrintingId) ?? null;
          if (chosenPrinting !== null && !choices.includes(chosenPrinting)) {
            // The intended printing stays reachable even when the language facet excludes it.
            choices.push(chosenPrinting);
          }
          printingChoice.replaceChildren(
            // An intended printing whose record has not loaded stays the selected choice, named by
            // its identity, instead of being replaced by one that happens to be loaded.
            ...(chosenPrinting === null
              ? [option(document, wantedPrintingId, `Printing ${wantedPrintingId}`)]
              : []),
            ...choices.map((known) => option(document, known.printingId, printingLine(known))),
          );
          printingChoice.value = wantedPrintingId;

          const selected = window.printings.get(wantedPrintingId) ?? null;
          const finishes =
            selected === null || selected.finishes.length === 0
              ? uiCatalogFinishes
              : selected.finishes;
          finish.replaceChildren(
            ...finishes.map((value) => option(document, value, uiFinishLabel(value))),
          );
          const finishValue = finishes.includes(wanted.finish as Finish)
            ? wanted.finish
            : (finishes[0] ?? '');
          finish.value = finishValue;

          const conditionValue =
            wanted.condition === 'unknown' ||
            uiCopyConditions.includes(wanted.condition as (typeof uiCopyConditions)[number])
              ? wanted.condition
              : 'unknown';
          condition.replaceChildren(
            option(document, 'unknown', 'Unknown'),
            ...uiCopyConditions.map((code) => option(document, code, conditionLabel(code))),
          );
          condition.value = conditionValue;

          draft = {
            language: chosenLanguage,
            printingId: wantedPrintingId,
            finish: finishValue,
            condition: conditionValue,
          };
          // A failed request keeps its retry reachable: only the end of the list hides the control
          // (docs/user-interface.md#browsing-and-organization).
          more.hidden = window.continuation === null && window.error === null;
          more.disabled = window.loading;
          more.textContent = window.error === null ? 'More printings' : 'Retry printings';
        }

        /** The attributes the account stores now, distinct from the unsaved draft. */
        function paintSaved(): void {
          const stored = window.printings.get(saved.printingId) ?? null;
          savedLine.textContent = `${stored === null ? `Printing ${saved.printingId}` : printingLine(stored)} · ${saved.finish} · ${conditionLabel(saved.condition)}`;
          printingLink.href = uiHref(viewOfCard(cardId, saved.printingId, null));
        }

        function readForm(): UiCopyDraft {
          return {
            language: language.value,
            printingId: printingChoice.value,
            finish: finish.value,
            condition: condition.value,
          };
        }

        /** The correction the form currently names, or null while a control names no value. */
        function correction(): UiCopyCorrection | null {
          draft = readForm();
          const finishValue = uiCatalogFinishes.find((value) => value === finish.value);
          if (finishValue === undefined || printingChoice.value.length === 0) {
            return null;
          }
          return {
            copyId: saved.copyId,
            expectedRevision: saved.revision,
            printingId: printingChoice.value,
            finish: finishValue,
            condition:
              condition.value === 'unknown'
                ? null
                : (uiCopyConditions.find((code) => code === condition.value) ?? null),
          };
        }

        async function saveCopy(): Promise<void> {
          const input = correction();
          if (input === null) {
            copyStatus.textContent = 'Choose a printing, a finish and a condition before saving.';
            return;
          }
          const current = ++work;
          save.disabled = true;
          copyStatus.textContent = 'Saving…';
          const outcome = await correctCopy(copies, input, context.signal);
          if (closed) {
            return;
          }
          save.disabled = false;
          if (outcome.copy !== null) {
            presentCopy(outcome.copy);
          }
          if (current === work) {
            copyStatus.textContent = outcome.message ?? 'Saved.';
          }
          if (outcome.status === 'conflict') {
            // The copy changed meanwhile: its current state is offered for review while the draft
            // the user wrote stays in the form for the retry.
            const reread = await readCurrent();
            if (!closed && reread.work === work && reread.status !== 'read') {
              copyStatus.textContent = readProblem(reread);
            }
          }
        }

        async function reloadCopy(): Promise<void> {
          copyStatus.textContent = 'Reloading…';
          const result = await readCurrent();
          if (closed || result.work !== work) {
            // A newer operation owns the feedback; the obsolete reload presents nothing.
            return;
          }
          copyStatus.textContent =
            result.status === 'read' ? 'Reloaded the copy.' : readProblem(result);
        }

        /**
         * Re-reads the copy the page corrects; the unsaved draft stays untouched. The presented
         * state never regresses, and a read that failed stays distinct from a copy the account no
         * longer holds, so a caller never reports an unavailable read as absence
         * (docs/user-cards.md#interface, docs/user-interface.md#state-ownership-and-restoration).
         */
        async function readCurrent(): Promise<UiCopyReadResult> {
          const current = ++work;
          try {
            const read = await copies.read([saved.copyId], context.signal);
            const found = read.copies[0] ?? null;
            if (found === null) {
              return { work: current, status: 'missing' };
            }
            presentCopy(found);
            return { work: current, status: 'read', copy: found };
          } catch (cause) {
            return {
              work: current,
              status: 'failed',
              message: readMessage(cause, 'The copy could not be reloaded.'),
            };
          }
        }

        /**
         * Presents the recorded state one read or write reported, unless the page presents a newer
         * revision already: a response that arrives after a newer operation never replaces the state
         * the user is looking at.
         */
        function presentCopy(found: PhysicalCopy): void {
          if (found.revision < saved.revision) {
            return;
          }
          saved = found;
          paintSaved();
          paint();
        }

        /** The problem one copy read reports; only a failed read carries a message of its own. */
        function readProblem(result: Exclude<UiCopyReadResult, { status: 'read' }>): string {
          return result.status === 'failed'
            ? result.message
            : 'This copy is no longer in the collection.';
        }

        /**
         * Loads the next page of the card's published printings into the bounded window the form
         * offers, or reports the failure beside the retry the same control offers. The window keeps
         * the printing the copy records and the intended draft; the rest of the working set is
         * bounded, so repeated pagination never retains every visited printing. A continuation the
         * catalog rejects as stale stays unusable, so the offer does not hold it: its paging
         * position starts again at the first page the published revision lists
         * (docs/catalog.md#provided-operations, docs/user-interface.md#browsing-and-organization).
         */
        async function loadMorePrintings(): Promise<void> {
          if (window.loading || context.signal.aborted) {
            return;
          }
          window.loading = true;
          paint();
          let continuation = window.continuation;
          try {
            let page: CardPrintingsPage;
            for (;;) {
              try {
                page = await catalog.listCardPrintings(cardId, {
                  pageSize: UI_LIMITS.printingPage,
                  ...(continuation === null ? {} : { continuation }),
                });
                break;
              } catch (cause) {
                if (
                  continuation === null ||
                  context.signal.aborted ||
                  readFailureCode(cause) !== 'stale-continuation'
                ) {
                  throw cause;
                }
                // The catalog changed after the page this continuation names was read, so the
                // provider keeps refusing it: the offer reads the printing list again from its
                // first page instead of keeping a cursor that can only fail again.
                continuation = null;
              }
            }
            for (const known of page.printings) {
              window.printings.set(known.printingId, known);
            }
            window.continuation = page.continuation;
            window.error = null;
            retirePrintings();
          } catch (cause) {
            // A continuation the catalog rejected as stale is not retained, not even when the
            // restarted read failed: the retry the control offers starts the printing list again.
            window.continuation = continuation;
            window.error = readMessage(cause, 'The printings could not be loaded.');
          } finally {
            window.loading = false;
          }
          if (closed) {
            return;
          }
          printingsStatus.textContent = window.error ?? '';
          paint();
        }

        /** Retires the oldest printings beyond the working set, keeping the presented choices. */
        function retirePrintings(): void {
          const kept = new Set([saved.printingId, draft?.printingId ?? '']);
          const keys = [...window.printings.keys()];
          const surplus = keys.slice(0, Math.max(0, keys.length - UI_LIMITS.listWindow));
          for (const key of surplus) {
            if (!kept.has(key)) {
              window.printings.delete(key);
            }
          }
        }
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

      function heading(id: string, text: string): HTMLHeadingElement {
        const element = document.createElement('h2');
        element.id = id;
        element.textContent = text;
        return element;
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

      function printingImage(printing: PrintingRecord): HTMLImageElement | null {
        const src =
          printing.images.normal ??
          printing.images.small ??
          printing.images.large ??
          printing.images.artCrop;
        if (src === null) {
          return null;
        }
        const image = document.createElement('img');
        image.id = 'printing-image';
        image.src = src;
        image.alt = printingLine(printing);
        return image;
      }
    },
  };
}

/** One printing as the page presents it: its edition, collector number and language. */
function printingLine(printing: PrintingRecord): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}

function conditionLabel(condition: string | null): string {
  switch (condition) {
    case null:
      return 'condition unknown';
    case 'NM':
      return 'near mint';
    case 'LP':
      return 'lightly played';
    case 'MP':
      return 'moderately played';
    case 'HP':
      return 'heavily played';
    case 'DMG':
      return 'damaged';
    default:
      return condition;
  }
}

function option(document: Document, value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
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
  const language = values.language;
  const printingId = values.printingId;
  const finish = values.finish;
  const condition = values.condition;
  if (
    typeof language !== 'string' ||
    typeof printingId !== 'string' ||
    typeof finish !== 'string' ||
    typeof condition !== 'string'
  ) {
    return null;
  }
  return { language, printingId, finish, condition };
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
