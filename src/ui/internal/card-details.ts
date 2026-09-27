/**
 * Card details page of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations).
 *
 * One URL names the level the page presents: the card, one printing of it or one physical copy.
 * The card and printing levels present the published catalog information the view names; the copy
 * level reads the account's actual copy through the private UserCards contract and resolves the
 * printing it references, so a corrected copy is presented with the printing it now carries. The
 * copy level corrects printing and language (the printing the copy references), finish and
 * condition as one change quoted by the revision the page read: a conflict or a failed change
 * keeps the unsaved draft for review and retry, a lost response is recovered from the copy's
 * recorded state, and a saved outcome is presented only after the change reported it committed
 * (docs/user-interface.md#browsing-and-organization). The draft is page state the page keeps for
 * its history entry, so leaving and returning keeps what a retry needs. Every provider value
 * renders as text.
 */

import type { CardRecord, Catalog, Finish, PrintingRecord } from '../../catalog/index.js';
import type { PhysicalCopy } from '../../usercards/index.js';

import {
  correctCopy,
  createCopyAccess,
  uiCopyConditions,
  type UiCopyCorrection,
} from './copy-edits.js';
import { UI_LIMITS } from './limits.js';
import { controlLabel, readPageState } from './page-support.js';
import type { UiPageDefinition } from './pages.js';
import { uiCatalogFinishes, uiHref, type UiView } from './routes.js';

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

/** One card's published printings, as the page loaded them so far. */
interface PrintingsState {
  readonly printings: Map<string, PrintingRecord>;
  continuation: string | null;
  loading: boolean;
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
      const copies = createCopyAccess(context.capabilities.userCards);
      /** The copy form's state, kept whether or not the form is presented at this moment. */
      let draft = readCopyDraft(restored);
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
        capture: () => (draft === null ? null : { draft }),
        presented: () => presented.promise,
      };

      /** Loads and presents the level the view names, or a failure the user can retry. */
      async function render(): Promise<void> {
        status.textContent = 'Loading card details…';
        content.replaceChildren();
        try {
          const nodes =
            cardView.copyId !== null
              ? await copyLevel(cardView.copyId)
              : cardView.printingId !== null
                ? await printingLevel(cardView.printingId)
                : await cardLevel();
          if (closed) {
            return;
          }
          content.replaceChildren(...nodes);
          status.textContent = '';
          presented.resolve();
        } catch (cause) {
          if (closed) {
            return;
          }
          content.replaceChildren(...failurePanel(cause));
          status.textContent = '';
          presented.reject(cause);
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
      async function cardLevel(): Promise<readonly Node[]> {
        const card = await resolveCard(catalog, cardView.cardId);
        return card === null
          ? [missingPanel('The catalog does not publish this card.')]
          : cardContent(card);
      }

      /** The printing level: one published version of one card. */
      async function printingLevel(printingId: string): Promise<readonly Node[]> {
        const resolution = await catalog.resolve([{ kind: 'printing', printingId }]);
        const printing = resolution.printings.get(printingId) ?? null;
        if (printing === null) {
          return [missingPanel('The catalog does not publish this printing.')];
        }
        const card = await resolveCard(catalog, printing.cardId);
        return card === null
          ? [missingPanel('The catalog does not publish the card of this printing.')]
          : printingContent(card, printing);
      }

      /**
       * The physical-copy level: the account's actual copy, its current attributes and the change
       * that corrects printing and language, finish and condition.
       */
      async function copyLevel(copyId: string): Promise<readonly Node[]> {
        const read = await copies.read([copyId], context.signal);
        const copy = read.copies[0] ?? null;
        if (copy === null) {
          return [missingPanel('This account has no physical copy with that identity.')];
        }
        const resolution = await catalog.resolve([
          { kind: 'printing', printingId: copy.printingId },
        ]);
        const printing = resolution.printings.get(copy.printingId) ?? null;
        const card = await resolveCard(catalog, printing?.cardId ?? cardView.cardId);
        return copyContent(copy, card, printing);
      }

      function cardContent(card: CardRecord): readonly Node[] {
        const printings: PrintingsState = {
          printings: new Map(),
          continuation: null,
          loading: false,
        };
        const list = document.createElement('ul');
        list.id = 'card-printings';
        const more = button('card-printings-more', 'More printings');
        const printingsStatus = line('card-printings-status', '');
        const paint = (): void => {
          list.replaceChildren(
            ...[...printings.printings.values()].map((printing) => printingItem(printing)),
          );
          more.hidden = printings.continuation === null;
          more.disabled = printings.loading;
        };
        more.addEventListener('click', () => {
          void loadPrintings(catalog, card.cardId, printings, context.signal).then(
            () => {
              printingsStatus.textContent = '';
              paint();
            },
            (cause: unknown) => {
              printingsStatus.textContent = readMessage(
                cause,
                'The printings could not be loaded.',
              );
            },
          );
        });
        paint();
        void loadPrintings(catalog, card.cardId, printings, context.signal).then(
          paint,
          (cause: unknown) => {
            printingsStatus.textContent = readMessage(cause, 'The printings could not be loaded.');
            paint();
          },
        );
        return [
          heading('card-name', card.name),
          line('card-type', card.typeLine ?? 'Type not published'),
          line('card-text', card.rulesText ?? 'No rules text published.'),
          line('card-printings-label', 'Published printings'),
          list,
          more,
          printingsStatus,
          collectionLinks(card),
        ];
      }

      function printingItem(printing: PrintingRecord): HTMLLIElement {
        const item = document.createElement('li');
        const anchor = link(
          `card-printing-${encodeURIComponent(printing.printingId)}`,
          viewOfCard(printing.cardId, printing.printingId, null),
          printingLine(printing),
        );
        item.append(anchor);
        return item;
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
        const cardId = printing?.cardId ?? cardView.cardId;
        const printings: PrintingsState = {
          printings: new Map(printing === null ? [] : [[printing.printingId, printing]]),
          continuation: null,
          loading: false,
        };
        const savedLine = line('copy-saved', '');
        const copyStatus = line('copy-status', '');
        copyStatus.setAttribute('role', 'status');
        copyStatus.setAttribute('aria-live', 'polite');
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
        );
        paintSaved();
        paint();
        form.addEventListener('change', () => {
          draft = readForm();
          paint();
        });
        more.addEventListener('click', () => {
          void loadPrintings(catalog, cardId, printings, context.signal).then(
            () => {
              copyStatus.textContent = '';
              paint();
            },
            (cause: unknown) => {
              copyStatus.textContent = readMessage(cause, 'The printings could not be loaded.');
            },
          );
        });
        reload.addEventListener('click', () => {
          void reloadCopy();
        });
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          void saveCopy();
        });
        if (card !== null) {
          void loadPrintings(catalog, cardId, printings, context.signal).then(
            () => paint(),
            () => {
              // The published printings are an offer: the copy's own printing stays correctable
              // even when the catalog list cannot be read.
            },
          );
        }
        return [
          section,
          navigation([
            printingLink,
            link('copy-card-link', viewOfCard(cardId, null, null), 'Card details'),
          ]),
        ];

        /**
         * Presents the draft in the controls, narrowed by the choices that are available: the
         * language narrows the printings, the printing decides the finishes that exist, and an
         * unavailable value falls back to one that exists. The effective values become the draft.
         */
        function paint(): void {
          const wanted = draft ?? {
            language: '',
            printingId: saved.printingId,
            finish: saved.finish,
            condition: saved.condition ?? 'unknown',
          };
          const languages = new Set<string>();
          for (const known of printings.printings.values()) {
            languages.add(known.language);
          }
          languages.add(printing?.language ?? wanted.language);
          const chosenLanguage = languages.has(wanted.language) ? wanted.language : '';
          language.replaceChildren(
            option(document, '', 'Any language'),
            ...[...languages]
              .filter((code) => code.length > 0)
              .sort()
              .map((code) => option(document, code, code)),
          );
          language.value = chosenLanguage;

          const choices = [...printings.printings.values()].filter(
            (known) => chosenLanguage === '' || known.language === chosenLanguage,
          );
          const chosenPrinting = printings.printings.get(wanted.printingId) ?? null;
          if (chosenPrinting !== null && !choices.includes(chosenPrinting)) {
            // The copy's own printing stays reachable even when the language facet excludes it.
            choices.push(chosenPrinting);
          }
          printingChoice.replaceChildren(
            ...choices.map((known) => option(document, known.printingId, printingLine(known))),
          );
          const printingId = choices.some((known) => known.printingId === wanted.printingId)
            ? wanted.printingId
            : (choices[0]?.printingId ?? '');
          printingChoice.value = printingId;

          const selected = printings.printings.get(printingId) ?? null;
          const finishes =
            selected === null || selected.finishes.length === 0
              ? uiCatalogFinishes
              : selected.finishes;
          finish.replaceChildren(
            ...finishes.map((value) => option(document, value, finishLabel(value))),
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
            printingId,
            finish: finishValue,
            condition: conditionValue,
          };
          more.hidden = printings.continuation === null;
          more.disabled = printings.loading;
        }

        /** The attributes the account stores now, distinct from the unsaved draft. */
        function paintSaved(): void {
          const stored = printings.printings.get(saved.printingId) ?? null;
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
          save.disabled = true;
          copyStatus.textContent = 'Saving…';
          const outcome = await correctCopy(copies, input, context.signal);
          if (closed) {
            return;
          }
          save.disabled = false;
          if (outcome.copy !== null) {
            saved = outcome.copy;
            paintSaved();
            paint();
          }
          copyStatus.textContent = outcome.message ?? 'Saved.';
          if (outcome.status === 'conflict') {
            // The copy changed meanwhile: its current state is offered for review while the draft
            // the user wrote stays in the form for the retry.
            await readCurrent();
          }
        }

        async function reloadCopy(): Promise<void> {
          copyStatus.textContent = 'Reloading…';
          const found = await readCurrent();
          if (closed) {
            return;
          }
          copyStatus.textContent =
            found === null ? 'This copy is no longer in the collection.' : 'Reloaded the copy.';
        }

        /** Re-reads the copy the page corrects; the unsaved draft stays untouched. */
        async function readCurrent(): Promise<PhysicalCopy | null> {
          try {
            const read = await copies.read([saved.copyId], context.signal);
            const found = read.copies[0] ?? null;
            if (found !== null) {
              saved = found;
              paintSaved();
              paint();
            }
            return found;
          } catch (cause) {
            if (!closed) {
              copyStatus.textContent = readMessage(cause, 'The copy could not be reloaded.');
            }
            return null;
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

function finishLabel(finish: Finish): string {
  return finish === 'nonfoil' ? 'Nonfoil' : finish === 'foil' ? 'Foil' : 'Etched';
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

/**
 * Loads the next page of one card's published printings into the state the page presents; the
 * pages stay bounded and the printings already presented stay available.
 */
async function loadPrintings(
  catalog: Catalog,
  cardId: string,
  state: PrintingsState,
  signal: AbortSignal,
): Promise<void> {
  if (state.loading || signal.aborted) {
    return;
  }
  state.loading = true;
  try {
    const page = await catalog.listCardPrintings(cardId, {
      pageSize: UI_LIMITS.printingPage,
      ...(state.continuation === null ? {} : { continuation: state.continuation }),
    });
    for (const printing of page.printings) {
      state.printings.set(printing.printingId, printing);
    }
    state.continuation = page.continuation;
  } finally {
    state.loading = false;
  }
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
