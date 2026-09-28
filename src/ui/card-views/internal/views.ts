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

/** One choice a picker offers for the explicit selection. */
export interface CardViewPickerChoice {
  /** Stable id the entry's tool availability fragment reports. */
  readonly id: string;
  /** Label of the choice's control. */
  readonly label: string;
  /** Runs the choice over the explicit selection the user made. */
  choose(selection: CardListToolSelection): void | Promise<void>;
}

/**
 * The picker a page or editor presents for card and printing choices. It is one list view over
 * the supplied CardList description, with the caller's choice offered as an explicit action over
 * the current selection.
 */
export interface CardViewPickerOptions<Context> extends Omit<UiCardListOptions<Context>, 'tools'> {
  /** The choice the picker offers, or absent while choosing is not available yet. */
  readonly choice?: CardViewPickerChoice;
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
    picker(options) {
      const choice = options.choice;
      return createCardListView({
        ...options,
        ...(choice === undefined
          ? {}
          : {
              tools: [
                {
                  id: choice.id,
                  label: choice.label,
                  tool: {
                    async invoke(request) {
                      // The choice itself reports the outcome of the operation it presents; the
                      // picker presents the outcome the caller returned through the list's own
                      // outcome line.
                      await choice.choose(request.selection);
                      return { status: 'committed' as const, message: null };
                    },
                  },
                },
              ],
            }),
      });
    },
  };
}
