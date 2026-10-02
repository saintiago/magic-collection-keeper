/**
 * CardList contract (docs/card-list.md#interface,
 * docs/card-list.md#required-interfaces-and-source-bindings).
 *
 * A list turns one described activity into a bounded, asynchronous presentation model: it
 * acquires entries through the supplied source, enriches them through independent fragment
 * readers, keeps selection beyond the loaded window, retains and restores its own context and
 * reports every observable state through an immutable snapshot. Consumers hand it provider
 * results through this component's own source/fragment protocol; providers never import these
 * presentation types.
 */

import type { PhysicalCopy } from '../../usercards/index.js';

/** Typed reference of one entry at the levels a list presents. */
export type CardListTarget =
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'printing'; readonly printingId: string }
  | { readonly kind: 'copy'; readonly copyId: string }
  /**
   * One pending import entry. It is not an owned record yet: the Import page reviews and corrects
   * the entry under its own identity before a confirmation creates the copies it represents
   * (docs/user-cards.md#import-and-capture-state).
   */
  | { readonly kind: 'pending'; readonly entryId: string };

/** Basic card information resolved with an entry. */
export interface CardListEntryCard {
  readonly cardId: string;
  readonly name: string;
  /** Translated or face name that matched the source, when it differs from the canonical name. */
  readonly matchedName: string | null;
  /**
   * Published type line, when the source read the card's presentation with the entry. Absent
   * means the source did not read it, not that the catalog publishes none.
   */
  readonly typeLine?: string | null;
  /** Published rules text, on the same terms as {@link typeLine}. */
  readonly rulesText?: string | null;
}

/** Basic printing information of a printing- or copy-level entry. */
export interface CardListEntryPrinting {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
  /**
   * Finishes the printing publishes, when the source read them with the entry: a detail or picker
   * presentation uses them, while a row renders the printing line alone.
   */
  readonly finishes?: readonly string[];
}

/** Basic information of one resolved entry; null while the entry is explicitly unresolved. */
export interface CardListEntryBasic {
  readonly card: CardListEntryCard;
  /** Printing information for a printing or copy entry; null at card level. */
  readonly printing: CardListEntryPrinting | null;
}

/** Counts an entry carries; unavailable counts are null, never zero. */
export interface CardListEntryQuantity {
  readonly copies: number | null;
  readonly intended: number | null;
}

export interface CardListEntry {
  /** Stable key of the entry; interaction state survives enrichment and refinement. */
  readonly key: string;
  readonly target: CardListTarget;
  /** Basic information resolved with the page, or null for an explicit unresolved entry. */
  readonly basic: CardListEntryBasic | null;
  /** Quantity context the source evaluated; null when it carries none. */
  readonly quantity: CardListEntryQuantity | null;
  /**
   * Detail facts of a typed detail-target entry, when the source read the level a detail view
   * presents (docs/ui/pages.md#page-map). A row source leaves it absent: rows render their basic
   * information and fragments.
   */
  readonly detail?: CardListEntryDetail;
}

/** Why one typed detail target carries no content: the level that could not be resolved. */
export type CardListEntryAbsence = 'card' | 'printing' | 'printing-card' | 'copy';

/**
 * The level facts of one typed detail target: the presentation of the card and printing the level
 * names, the private copy record when the level presents a physical copy, and the explicit absence
 * of a target the provider does not publish. A detail source reads them together with the entry,
 * so the presentation composes the level from what the list published instead of reading content
 * itself.
 */
export interface CardListEntryDetail {
  /** Explicit absence of the target; null when the level resolved. */
  readonly absent: CardListEntryAbsence | null;
  /** The private copy record a copy-level entry presents; null at another level. */
  readonly copy: PhysicalCopy | null;
}

/** One image of an entry's images fragment; the presentation shows visible, named images only. */
export interface CardListEntryImage {
  readonly src: string;
  readonly alt: string;
}

/** Ownership counts of one entry's ownership fragment. */
export interface CardListEntryOwnership {
  /** Physical copies of the entry the account owns. */
  readonly owned: number;
  /** Intended quantity for the presented tag, when this fragment reads one. */
  readonly intended?: number | null;
  /** Physical locations holding those copies, or null when the count is unavailable. */
  readonly locations: number | null;
}

/** One label of an entry's tags fragment. */
export interface CardListEntryTag {
  readonly tagId: string;
  readonly name: string;
}

/**
 * Information a fragment request asks for. Each kind loads, refreshes and fails independently of
 * the basic entry information and of the other kinds (docs/card-list.md#loading-and-recovery).
 */
export const cardListFragmentKinds = ['images', 'ownership', 'tags', 'tools'] as const;

export type CardListFragmentKind = (typeof cardListFragmentKinds)[number];

/** Enrichment request for explicit entry keys. */
export interface CardListFragmentRequest {
  readonly keys: readonly string[];
  readonly information: readonly CardListFragmentKind[];
  readonly signal: AbortSignal;
}

/**
 * One entry's enrichment outcome for the requested information. `ready` carries the resolved
 * information, `absent` is a definitive empty answer and `failed` a reported failure; a failed
 * fragment is never presented as an empty result. The value shape stays with the binding.
 */
export type CardListFragmentResult<Value = unknown> =
  | { readonly key: string; readonly status: 'ready'; readonly values: Value }
  | { readonly key: string; readonly status: 'absent'; readonly values: null }
  | { readonly key: string; readonly status: 'failed'; readonly message: string };

/** Reads the requested information for explicit entry keys. */
export interface CardListFragmentReader<Value = unknown> {
  /** Binding-owned invalidation, independent of page subscriptions. */
  subscribe?(listener: () => void): () => void;
  read(request: CardListFragmentRequest): Promise<readonly CardListFragmentResult<Value>[]>;
}

/** Fragment readers of one list; a kind without a reader is not presented at all. */
export interface CardListFragmentReaders {
  readonly images?: CardListFragmentReader<readonly CardListEntryImage[]>;
  readonly ownership?: CardListFragmentReader<CardListEntryOwnership>;
  readonly tags?: CardListFragmentReader<readonly CardListEntryTag[]>;
  /** Tool ids available for the entry; a tool is offered once every selected entry reports it. */
  readonly tools?: CardListFragmentReader<readonly string[]>;
}

/** A settled fragment answer that stays usable while the list refreshes it. */
export type CardListSettledFragmentState<Value = unknown> =
  { readonly status: 'ready'; readonly values: Value } | { readonly status: 'absent' };

/**
 * State one entry's fragment presents. Refresh work is distinct from first-load work and retains
 * the last settled answer; a failed refresh reports its failure without turning that answer into
 * an empty result (docs/card-list.md#loading-and-recovery).
 */
export type CardListFragmentState<Value = unknown> =
  | { readonly status: 'loading' }
  | CardListSettledFragmentState<Value>
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'refreshing';
      readonly previous: CardListSettledFragmentState<Value>;
    }
  | {
      readonly status: 'refresh-failed';
      readonly previous: CardListSettledFragmentState<Value>;
      readonly message: string;
    };

/** Selection context one tool invocation acts on; it is explicit, never inferred from a view. */
export interface CardListToolSelection {
  /** Stable keys of the selected entries. */
  readonly keys: readonly string[];
  /** Typed targets of the selected entries, aligned with `keys`. */
  readonly targets: readonly CardListTarget[];
}

/** Advisory action descriptor; execution belongs to the consumer's editor. */
export interface CardListTool {
  readonly id: string;
  readonly label: string;
}

/** Query context one source evaluates; the binding owns its concrete shape. */
export interface CardListSourceRequest<Context> {
  readonly context: Context;
  readonly pageSize: number;
  /** Opaque continuation of the next page, or null to start the result. */
  readonly continuation: string | null;
  /** Cancelling it withdraws the request; a withdrawn page is never presented. */
  readonly signal: AbortSignal;
}

export interface CardListPage {
  readonly entries: readonly CardListEntry[];
  /** Opaque continuation of the next page, or null when this page ends the result. */
  readonly continuation: string | null;
}

/**
 * Outcome of one source read: the page it supplies, or the report that the sequence the request
 * names can no longer be continued and must restart from its beginning, so the list never repeats
 * the rejected continuation. A read that merely failed temporarily rejects instead, keeping the
 * position it asked for. Bindings translate each provider's own failure semantics into this
 * contract, and the list never interprets provider error codes (docs/card-list.md#interface).
 */
export type CardListRead =
  ({ readonly status: 'page' } & CardListPage) | { readonly status: 'invalidated' };

/** A source supplies entries, the end of the result and access to further pages. */
export interface CardListSource<Context = unknown> {
  load(request: CardListSourceRequest<Context>): Promise<CardListRead>;
  /**
   * Whether one committed-change notification touches the sequence this source reads. A binding
   * that reads a specific import or tag answers for its own identity; a source without the hook is
   * reacquired for every notification (docs/card-list.md#loading-and-recovery).
   */
  affects?(change: CardListChange, context: Context): boolean;
}

/** Source position of the first entry of one list window (docs/card-list.md#selection-and-restoration). */
export interface CardListPosition {
  /** Opaque continuation of the request that supplied the entry; null for the first page. */
  readonly continuation: string | null;
  /** Index of the entry among the entries that request returned. */
  readonly offset: number;
}

/** One control of a list that holds keyboard focus. */
export type CardListFocus =
  | { readonly control: 'select'; readonly key: string }
  | { readonly control: 'group'; readonly keys: readonly string[] }
  | { readonly control: 'fragment'; readonly key: string; readonly kind: CardListFragmentKind }
  /** A control the consumer rendered for one entry, named by the stable element id it gave it. */
  | { readonly control: 'element'; readonly id: string };

/** One selected entry the retained window no longer presents, with its typed target. */
export interface CardListSelectedTarget {
  readonly key: string;
  readonly target: CardListTarget;
}

/**
 * Logical position one presentation reports to its list. The presentation owns physical scroll
 * and focus; the list retains the position in its own vocabulary so it never keeps a DOM object
 * (docs/card-list.md#interface, docs/card-list.md#selection-and-restoration).
 */
export interface CardListPositionReport {
  /** Scroll offset of the list's container. */
  readonly scrollTop?: number;
  /** Control of the list that holds focus, or null. */
  readonly focus?: CardListFocus | null;
  /**
   * Whether the presentation applied the list's retained position. `false` reports that explicit
   * user input took the interaction over, so the list keeps the user's interaction instead of the
   * retained one.
   */
  readonly applied?: boolean;
}

/**
 * Opaque state one list retains for its consumer's history entry
 * (docs/card-list.md#selection-and-restoration). Only the list that produced a handle can read or
 * restore it, and it is scoped to the account and instance type that produced it; the consumer
 * keeps it without decoding it.
 */
declare const cardListRetainedBrand: unique symbol;

export interface CardListRetained<Context = unknown> {
  /** Brand that keeps a retained handle opaque to its consumer. */
  readonly [cardListRetainedBrand]: (context: Context) => Context;
}

/**
 * Lifecycle of the restoration one visit performs for the state its consumer handed back. Resolves
 * with the retained logical position once the list presented the retained window, and rejects when
 * it could not present it; the consumer reports that result through its own lifecycle contract and
 * applies the position through `reportPosition` (docs/card-list.md#selection-and-restoration).
 */
export interface CardListRestoration {
  readonly presented: Promise<CardListPositionReport>;
}

/** One presented group; equivalent copies share it while keeping their individual identities. */
export interface CardListGroup {
  /** Identity of the group inside one rendering. */
  readonly key: string;
  /** Stable keys of the grouped entries, in source order. */
  readonly keys: readonly string[];
  /** Printing that makes the grouped entries equivalent; null for an ungrouped entry. */
  readonly printingId: string | null;
}

/** One entry of a snapshot with the independent states of its enrichment. */
export interface CardListEntrySnapshot {
  readonly entry: CardListEntry;
  /** Fragment states of this entry; a kind without a state is not presented for it. */
  readonly fragments: ReadonlyMap<CardListFragmentKind, CardListFragmentState>;
}

/** Selection the snapshot reports: explicit keys with the typed targets they act on. */
export interface CardListSelection {
  /**
   * Stable keys of the selected entries in a stable order, including entries the loaded window
   * does not present.
   */
  readonly keys: readonly string[];
  /**
   * Typed targets aligned with `keys`. A key selected before its entry arrived is kept privately
   * and reported once the source presents the entry, so an action never silently drops or
   * substitutes an identity (docs/card-list.md#selection-and-restoration).
   */
  readonly targets: readonly CardListTarget[];
  /**
   * Keys whose presented entry no longer carries the identity the selection holds — the source
   * replaced the target under the same key. The listed targets are the identities the selection
   * keeps; they are not acted on until the user explicitly selects the presented entry again
   * (docs/card-list.md#selection-and-restoration).
   */
  readonly unavailable: readonly string[];
}

/** One presented tool of a snapshot and whether the explicit selection may invoke it now. */
export interface CardListToolState {
  readonly id: string;
  readonly label: string;
  /** Every selected entry reports the tool available, so no invocation acts on a subset. */
  readonly available: boolean;
}

/**
 * One immutable view of a list: what it presents now and how far its work has come
 * (docs/card-list.md#interface).
 */
export interface CardListSnapshot<Context = unknown> {
  /** Query context of the active result. */
  readonly context: Context;
  /** Entries of the loaded window, in source order, with their fragment states. */
  readonly entries: readonly CardListEntrySnapshot[];
  /** Group descriptors of the window, in presentation order. */
  readonly groups: readonly CardListGroup[];
  readonly selection: CardListSelection;
  /** Presented tools in construction order; `available` follows the current selection. */
  readonly tools: readonly CardListToolState[];
  /** Whether a window request is in flight. */
  readonly loading: boolean;
  /** Failure of the last window request, or null; the loaded window stays usable either way. */
  readonly error: string | null;
  /**
   * Whether the active result continues past the loaded window and may be paged now. False while
   * the presented window belongs to a query a refinement superseded and while the last request
   * failed; `retry` repeats that request.
   */
  readonly hasMore: boolean;
  /** Whether the loaded window holds no entries; an empty, current result, not a failed read. */
  readonly empty: boolean;
  /**
   * Entries the active sequence has supplied, counted from its start, including those the window
   * bound retired. A presentation asks for a further extent from this count, so a bounded window
   * still reaches every further result.
   */
  readonly acquired: number;
  /**
   * Generation of the presented window; it advances whenever the source supplied entries again.
   * A presentation re-renders what depends on content outside the snapshot when it changed.
   */
  readonly generation: number;
}

/**
 * Extent of the presentation's viewport. A consumer reports the range it can present and the
 * fragment kinds it needs for it; the list answers with bounded acquisition and enrichment work
 * instead of a request per row (docs/card-list.md#interface).
 */
export interface CardListViewportDemand {
  /**
   * Number of entries of the active sequence the presentation needs, counted from the start of the
   * sequence; the list keeps its own window bound.
   */
  readonly entries: number;
  /**
   * Fragment kinds the presentation needs for the visible entries; absent keeps every kind the
   * list was given a reader for.
   */
  readonly information?: readonly CardListFragmentKind[];
}

/**
 * One local committed-change notification. It requests a read of the scope it names and is never a
 * second copy of authoritative data, so a list reacquires affected content through its source and
 * no consumer patches rows (docs/card-list.md#loading-and-recovery).
 */
export interface CardListChange {
  /** Membership, quantities or records the change may have affected. */
  readonly scope: 'copies' | 'tags' | 'associations' | 'imports' | 'catalog';
  /** Record identities the change named; empty when the scope is enough. */
  readonly records: readonly string[];
  /** Pending imports whose entries may have changed. */
  readonly imports: readonly string[];
}

export interface CardListOptions<Context = unknown> {
  /** Source of the entries, their continuation and the query context. */
  readonly source: CardListSource<Context>;
  /** Query context of the active result; the description contains intent, not fetched rows. */
  readonly context: Context;
  /** Verified account the list belongs to; retained state is scoped to it. */
  readonly accountId: string;
  /** Entries one page asks for; from 1 to {@link CARD_LIST_LIMITS.page}. */
  readonly pageSize: number;
  /**
   * State a previous visit of this list retained. The list restores its window, selection and
   * logical position through its own source and reports the outcome through `restoration`;
   * refresh and refinement start a fresh result instead.
   */
  readonly restored?: CardListRetained<Context> | null;
  /** Fragment readers; kinds without one are not presented. */
  readonly fragments?: CardListFragmentReaders;
  /** Tools presented for the explicit selection, in order. */
  readonly tools?: readonly CardListTool[];
  /**
   * Committed-change notifications of the account this list belongs to. The list reacquires the
   * content its source declares affected; a consumer never patches rows for a change
   * (docs/card-list.md#required-interfaces-and-source-bindings).
   */
  readonly changes?: CardListChangeSource;
  /** Aborted when the consumer closes the view; the list stops loading and drops late results. */
  readonly signal?: AbortSignal;
}

/** The committed-change notifications one account's lists reacquire from. */
export interface CardListChangeSource {
  /** Observes committed changes of one account; the returned call stops delivery. */
  subscribe(listener: (change: CardListChange) => void): () => void;
}

/**
 * One headless list over one source. It keeps its query, loaded window, selection, enrichment and
 * restoration state private and reports observable state through snapshots
 * (docs/card-list.md#interface).
 */
export interface CardList<Context = unknown> {
  /** Current snapshot; every change of observable state publishes a new immutable value. */
  snapshot(): CardListSnapshot<Context>;
  /** Observes snapshots; the returned call stops delivery. */
  subscribe(listener: (snapshot: CardListSnapshot<Context>) => void): () => void;
  /**
   * State this list retains for its consumer's history entry: its query, the position and size of
   * the presented window, the full selection with the typed targets of entries outside it, and the
   * logical position the presentation reported. While a restoration is still loading it is the
   * intended state, never the partial window.
   */
  retain(): CardListRetained<Context>;
  /**
   * Lifecycle of restoring the state supplied in `restored`, or null when this visit restored
   * none.
   */
  readonly restoration: CardListRestoration | null;
  /** Reports the visible range and needed fragment kinds; acquires bounded further work. */
  demand(request: CardListViewportDemand): void;
  /** Starts a new result for `context`; usable content stays until the fresh page arrives. */
  refine(context: Context): void;
  /**
   * Reloads the active result from its first page, keeping the window until it arrives, and
   * rechecks the committed changes it still awaits (docs/card-list.md#loading-and-recovery).
   */
  refresh(): void;
  /**
   * Recovers the active result: it repeats the failed request — the position a temporary failure
   * kept, or the first page of a sequence whose restart failed; never another query's continuation.
   */
  retry(): void;
  /**
   * Re-reads one fragment of one entry (also tool availability of a selected entry retired by
   * paging); the other fragments stay unchanged and an outstanding read of that entry's kind is
   * retired instead of answering the fresh one.
   */
  reloadFragment(key: string, kind: CardListFragmentKind): void;
  /** Re-reads one kind across the active working set, superseding its outstanding reads. */
  reloadFragments(kind: CardListFragmentKind): void;
  /** Marks one entry selected; a key may be selected before its entry is loaded. */
  setSelected(key: string, selected: boolean): void;
  /** Marks every entry of one group selected, as the group's own control does. */
  setGroupSelected(keys: readonly string[], selected: boolean): void;
  /** Unselects every entry. */
  clearSelection(): void;
  /** Explicit action context of the current selection, including entries beyond the window. */
  actionContext(): CardListToolSelection;
  /** Applies a committed-change notification; affected content is reacquired through its source. */
  changed(change: CardListChange): void;
  /** Retains the logical position the presentation reports; updates what `retain` captures. */
  reportPosition(position: CardListPositionReport): void;
  /**
   * Releases the resources retained for an outstanding restoration without disposing the list: the
   * intended window is abandoned and its lifecycle reports the interruption.
   */
  release(): void;
  /** Releases the list; outstanding responses are dropped and no snapshot is delivered again. */
  dispose(): void;
}
