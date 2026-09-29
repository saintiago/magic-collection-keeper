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

import type {
  CardListEntry,
  CardListEntryAbsence,
  CardListSnapshot,
  CardListToolSelection,
  CardListFragmentReaders,
  CardListSource,
} from '../../../card-list/index.js';

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
 * The detail one page presents for a typed target — a card, one of its printings or one physical
 * copy. The page owns the route and the children it composes into the level; the view creates the
 * level's list through the supplied CardList capability, renders the identity the list publishes
 * and reports the level's own load to the page, so a page never acquires card or copy content
 * itself (docs/ui/pages.md#page-map, docs/ui/card-views.md#interface).
 */
export interface CardViewDetailOptions<Context = unknown> {
  readonly document: Document;
  /** Application-selected CardList implementation; the view creates the level's list with it. */
  readonly create: UiCardListOptions<Context>['create'];
  /** Description of the level's content: one source of the published typed target. */
  readonly source: CardListSource<Context>;
  /** Target the description names. */
  readonly context: Context;
  /** Verified account the level belongs to. */
  readonly accountId: string;
  /** Entries one level read asks for. */
  readonly pageSize: number;
  /** Identity the view renders from the published entry: the level the route names. */
  readonly identity: 'card' | 'printing' | 'none';
  /** Fragment readers of the level, such as the printing images the identity presents. */
  readonly fragments?: CardListFragmentReaders;
  /**
   * Nodes the page composes for the published entry, after the identity information: the level's
   * related list or the editor it presents. Called for explicit absence too, so the page can
   * release previously composed children. The page keeps the children it creates here.
   */
  readonly content?: (entry: CardListEntry) => readonly Node[];
  /** Navigation the page presents after the composed content, from the entry it published. */
  readonly navigation?: (entry: CardListEntry) => readonly Node[];
  /** Aborted when the page closes; the level stops loading and drops late results. */
  readonly signal?: AbortSignal;
}

/** Presentation of one detail level. */
export interface CardViewDetail {
  /** The detail's nodes in presentation order. */
  readonly nodes: readonly Node[];
  /**
   * Settles when the level presented the target's content or its explicit absence, and rejects
   * when the level's read failed: the page reports that failure and its retry.
   */
  readonly presented: Promise<void>;
  /** Releases the level's list and the content the page composed into it. */
  dispose(): void;
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
  /** Presentation of one typed detail target over a supplied CardList description. */
  detail<Context>(options: CardViewDetailOptions<Context>): CardViewDetail;
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
    detail<Context>(options: CardViewDetailOptions<Context>): CardViewDetail {
      const document = readDocument(options?.document);
      // The level is one typed target: the view presents the identity and the content the page
      // composes, so it uses the headless list the supplied factory constructs instead of the
      // rendered list presentation of a page.
      const list = options.create<Context>({
        source: options.source,
        context: options.context,
        accountId: options.accountId,
        pageSize: options.pageSize,
        ...(options.fragments === undefined ? {} : { fragments: options.fragments }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const presented = Promise.withResolvers<void>();
      // A page that never awaits the level must not surface a rejection it did not report.
      presented.promise.catch(() => {});
      let settled = false;
      let composedKey: string | null = null;
      let disposed = false;
      let composedGeneration = -1;
      /**
       * Renders the identity and the composition of the published entry. The entry of one level is
       * one target, so a snapshot that repeats it renders nothing again; a snapshot that supplies
       * it after a refresh composes the content again for the entry the level presents now.
       */
      const identityHost = document.createElement('div');
      identityHost.id = 'card-details-identity';
      const imageHost = document.createElement('div');
      const contentHost = document.createElement('div');
      contentHost.id = 'card-details-level';
      const paint = (snapshot: CardListSnapshot<Context>): void => {
        if (disposed) {
          return;
        }
        const entry = snapshot.entries[0]?.entry ?? null;
        if (entry === null) {
          if (snapshot.error !== null) {
            report(snapshot.error);
            return;
          }
          if (!snapshot.loading) {
            // The source supplied no entry without failing: the level has no content to present.
            report('The details could not be presented.');
          }
          return;
        }
        const generation = snapshot.generation;
        if (entry.key !== composedKey || generation !== composedGeneration) {
          composedKey = entry.key;
          composedGeneration = generation;
          identityHost.replaceChildren(...identityNodes(document, options.identity, entry));
          const composed = options.content?.(entry) ?? [];
          const links = entry.detail?.absent == null ? (options.navigation?.(entry) ?? []) : [];
          contentHost.replaceChildren(...composed, ...links);
        }
        // Enrichment can change without changing the entry or generation. Reconcile only its
        // region, preserving the mounted children and their focus while fragments arrive.
        imageHost.replaceChildren(...imageNodes(document, options.identity, snapshot));
        settle();
      };
      const unsubscribe = list.subscribe(paint);
      if (options.identity === 'printing') {
        // Demand belongs to mounting this one-entry viewport, never to snapshot rendering.
        list.demand({ entries: 1, information: ['images'] });
      }
      paint(list.snapshot());
      if (options.signal?.aborted) {
        dispose();
      } else {
        options.signal?.addEventListener('abort', dispose, { once: true });
      }

      function report(problem: string): void {
        if (settled) {
          return;
        }
        settled = true;
        presented.reject(new Error(problem));
      }

      function settle(): void {
        if (settled) {
          return;
        }
        settled = true;
        presented.resolve();
      }

      function dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        options.signal?.removeEventListener('abort', dispose);
        unsubscribe();
        list.dispose();
      }

      return {
        nodes: [identityHost, imageHost, contentHost],
        presented: presented.promise,
        dispose,
      };
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

/** The document a view creates its elements in. */
function readDocument(document: Document | undefined): Document {
  if (document === undefined || typeof document.createElement !== 'function') {
    throw new TypeError('A CardViews detail view requires the document it creates elements in.');
  }
  return document;
}

/**
 * The identity of one detail level, as the published entry presents it: a card's basic
 * information, a printing's line and finishes, or the explicit missing panel of a target the
 * provider does not publish. The copy level composes no identity of its own.
 */
function identityNodes(
  document: Document,
  identity: 'card' | 'printing' | 'none',
  entry: CardListEntry,
): readonly Node[] {
  const absent = entry.detail?.absent ?? null;
  if (absent !== null) {
    return [missingPanel(document, missingMessage(absent))];
  }
  const basic = entry.basic;
  if (basic === null) {
    return [missingPanel(document, 'The details are not published.')];
  }
  if (identity === 'none') {
    return [];
  }
  if (identity === 'card') {
    return [
      heading(document, 'card-name', basic.card.name),
      line(document, 'card-type', basic.card.typeLine ?? 'Type not published'),
      line(document, 'card-text', basic.card.rulesText ?? 'No rules text published.'),
    ];
  }
  const printing = basic.printing;
  if (printing === null) {
    return [heading(document, 'printing-name', basic.card.name)];
  }
  const finishes = printing.finishes ?? [];
  return [
    heading(document, 'printing-name', basic.card.name),
    line(document, 'printing-line', printingLine(printing)),
    line(
      document,
      'printing-finishes',
      finishes.length === 0 ? 'No finish published' : `Finishes: ${finishes.join(', ')}`,
    ),
  ];
}

/** The image of the presented printing, once its images fragment reports one. */
function imageNodes(
  document: Document,
  identity: 'card' | 'printing' | 'none',
  snapshot: CardListSnapshot<unknown>,
): readonly Node[] {
  if (identity !== 'printing') {
    return [];
  }
  const state = snapshot.entries[0]?.fragments.get('images');
  if (state?.status === 'failed') {
    return [line(document, 'printing-image-status', state.message)];
  }
  if (state?.status === 'loading') {
    return [line(document, 'printing-image-status', 'Loading printing image…')];
  }
  if (state?.status !== 'ready') {
    return [];
  }
  const images = state.values as readonly { readonly src: string; readonly alt: string }[];
  const visible = images[0];
  if (visible === undefined) {
    return [];
  }
  const image = document.createElement('img');
  image.id = 'printing-image';
  image.src = visible.src;
  image.alt = visible.alt;
  return [image];
}

/** The presentation one explicit absence shows. */
function missingMessage(absent: CardListEntryAbsence): string {
  switch (absent) {
    case 'card':
      return 'The catalog does not publish this card.';
    case 'printing':
      return 'The catalog does not publish this printing.';
    case 'printing-card':
      return 'The catalog does not publish the card of this printing.';
    case 'copy':
      return 'This account has no physical copy with that identity.';
  }
}

/** One missing panel of a detail level. */
function missingPanel(document: Document, message: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.id = 'card-details-missing';
  element.textContent = message;
  return element;
}

/** One printing as the detail presents it: its edition, collector number and language. */
function printingLine(printing: {
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
}): string {
  return `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
}
