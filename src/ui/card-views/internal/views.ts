/**
 * CardViews implementation (docs/ui/card-views.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * One CardViews module presents the card, list, detail and picker views of the UserInterface over
 * a supplied CardList factory. It renders the immutable snapshots a list publishes, translates
 * pointer, keyboard and touch input into explicit entry-keyed intents, applies requested position
 * and focus, and reports whether a requested visual position was applied. It groups nothing,
 * sums nothing, filters no membership and follows no continuation of its own: the list behind the
 * view owns acquiring, windowing, enrichment, selection, recovery and retention
 * (docs/card-list.md#interface).
 */

import type { CardListEntry, CardListToolSelection } from '../../../card-list/index.js';
import type { CardRecord, PrintingRecord } from '../../../catalog/index.js';

import type { UiActionIntent } from '../../shared/actions.js';

import {
  cardListBasicContent,
  createCardListView,
  type UiCardList,
  type UiCardListOptions,
  type UiCardListPresentation,
} from './list.js';

/** One entry the view presents as an openable target. */
export interface CardViewOpenOptions {
  /** Document the view creates its elements in. */
  readonly document: Document;
  /** Prefix of the stable element id each entry's control carries. */
  readonly idPrefix: string;
  /**
   * Location the entry opens, or null when the entry carries no openable identity. The page owns
   * the route vocabulary; the view only renders the location it is given and reports the intent.
   */
  href(entry: CardListEntry): string | null;
  /** Reports the open intent for the entry the user opened. */
  onOpen?(entry: CardListEntry): void;
}

/** Presentation of one entry that opens the target it names. */
export type CardViewEntryPresentation = Required<Pick<UiCardListPresentation, 'renderEntry'>>;

/**
 * One choice a picker offers for the explicit selection. Choosing reports the selection the user
 * made to the caller that supplied the choice: the picker neither runs an operation nor presents
 * an outcome, because a selection is not a commitment
 * (docs/ui/card-views.md#interface, docs/ui/editors.md#interface).
 */
export interface CardViewPickerChoice {
  /** Stable id the entry's tool availability fragment reports. */
  readonly id: string;
  /** Label of the choice's control. */
  readonly label: string;
}

/**
 * The picker a page or editor presents for card and printing choices. It is one list view over
 * the supplied CardList description, with the caller's choice offered as an explicit control the
 * user expresses an intent through. The caller owns what the choice does with the selection it
 * receives.
 */
export interface CardViewPickerOptions<Context> extends Omit<
  UiCardListOptions<Context>,
  'tools' | 'onAction'
> {
  /** The choice the picker offers, or absent while choosing is not available yet. */
  readonly choice?: CardViewPickerChoice;
  /** Reports the explicit selection the user chose with. */
  onChoose?(selection: CardListToolSelection): void;
}

/**
 * The detail one page presents for a published card or printing. The page owns the route, the
 * level it resolves and the related lists and editors it composes; the view owns the presentation
 * of the identity it is handed.
 */
export interface CardViewDetailOptions {
  readonly document: Document;
  /** Published card the detail presents. */
  readonly card: CardRecord;
  /** Published printing the level presents, or null at the card level. */
  readonly printing: PrintingRecord | null;
  /** Nodes the page composes into the detail after its own identity information. */
  readonly content?: readonly Node[];
  /** Navigation the page presents after the composed content. */
  readonly navigation?: readonly Node[];
}

/** Presentation of one card or printing detail. */
export interface CardViewDetail {
  /** The detail's nodes in presentation order. */
  readonly nodes: readonly Node[];
}

/**
 * The presentation module of the UI composition. Pages and Editors receive this interface, so
 * replacing the rendering needs no consumer change; a view owns its mounted DOM and nothing
 * behind it.
 */
export interface CardViews {
  /** Default basic information of one entry. */
  basicContent(document: Document, entry: CardListEntry): Node;
  /** Builds one mounted list view over the description a page supplies. */
  list<Context>(options: UiCardListOptions<Context>): UiCardList<Context>;
  /** Presentation that opens each entry through the location the page supplies. */
  openEntries(options: CardViewOpenOptions): CardViewEntryPresentation;
  /** Presentation of one published card or printing detail. */
  detail(options: CardViewDetailOptions): CardViewDetail;
  /** Builds one mounted picker list over the description a page or editor supplies. */
  picker<Context>(options: CardViewPickerOptions<Context>): UiCardList<Context>;
}

/** The default CardViews module of the browser application. */
export function createCardViews(): CardViews {
  return {
    basicContent: (document, entry) => cardListBasicContent(document, entry),
    list: (options) => createCardListView(options),
    openEntries(options) {
      return {
        renderEntry(entry) {
          const content = cardListBasicContent(options.document, entry);
          const href = options.href(entry);
          if (href === null) {
            return content;
          }
          const link = options.document.createElement('a');
          link.id = `${options.idPrefix}-${encodeURIComponent(entry.key)}`;
          link.href = href;
          link.dataset.uiOpen = entry.key;
          link.append(content);
          link.addEventListener('click', () => options.onOpen?.(entry));
          return link;
        },
      };
    },
    detail(options) {
      const document = options.document;
      const printing = options.printing;
      const nodes: Node[] =
        printing === null
          ? [
              heading(document, 'card-name', options.card.name),
              line(document, 'card-type', options.card.typeLine ?? 'Type not published'),
              line(document, 'card-text', options.card.rulesText ?? 'No rules text published.'),
            ]
          : [
              heading(document, 'printing-name', options.card.name),
              line(document, 'printing-line', printingLine(printing)),
              line(
                document,
                'printing-finishes',
                printing.finishes.length === 0
                  ? 'No finish published'
                  : `Finishes: ${printing.finishes.join(', ')}`,
              ),
            ];
      const image = printing === null ? null : printingImage(document, printing);
      if (image !== null) {
        nodes.push(image);
      }
      nodes.push(...(options.content ?? []), ...(options.navigation ?? []));
      return { nodes };
    },
    picker(options) {
      const { choice, onChoose, ...rest } = options;
      return createCardListView({
        ...rest,
        ...(choice === undefined ? {} : { tools: [{ id: choice.id, label: choice.label }] }),
        ...(onChoose === undefined
          ? {}
          : { onAction: (intent: UiActionIntent) => onChoose(intent.selection) }),
      });
    },
  };
}

/** One heading of the detail presentation. */
function heading(document: Document, id: string, text: string): HTMLHeadingElement {
  const element = document.createElement('h2');
  element.id = id;
  element.textContent = text;
  return element;
}

/** One text line of the detail presentation. */
function line(document: Document, id: string, text: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.id = id;
  element.textContent = text;
  return element;
}

/** One printing as the detail presents it: its edition, collector number and language. */
function printingLine(printing: PrintingRecord): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}

/** The image of one printing, or null when the catalog publishes none. */
function printingImage(document: Document, printing: PrintingRecord): HTMLImageElement | null {
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
