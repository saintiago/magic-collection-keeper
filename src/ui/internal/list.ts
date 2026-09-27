/**
 * List boundary of the UserInterface (docs/user-interface.md#interface,
 * docs/user-interface.md#cardlist).
 *
 * Pages adapt Search results and UserCards pending entries into this presentation contract; the
 * providers do not import it. A source supplies bounded pages and their continuation, a fragment
 * request enriches entry keys with separately loading information, and a tool invokes the owning
 * component's operation for explicit targets. CardList implements the asynchronous presentation
 * over these contracts.
 */

/** Typed reference of one entry at the presentation levels. */
export type UiEntryTarget =
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'printing'; readonly printingId: string }
  | { readonly kind: 'copy'; readonly copyId: string };

/** Basic card information resolved with an entry. */
export interface UiEntryCard {
  readonly cardId: string;
  readonly name: string;
  /** Translated or face name that matched the source, when it differs from the canonical name. */
  readonly matchedName: string | null;
}

/** Basic printing information of a printing- or copy-level entry. */
export interface UiEntryPrinting {
  readonly printingId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
}

/** Basic information of one resolved entry; null while the entry is explicitly unresolved. */
export interface UiEntryBasic {
  readonly card: UiEntryCard;
  /** Printing information for a printing or copy entry; null at card level. */
  readonly printing: UiEntryPrinting | null;
}

/** Counts an entry carries; unavailable counts are null, never zero. */
export interface UiEntryQuantity {
  readonly copies: number | null;
  readonly intended: number | null;
}

export interface UiListEntry {
  /** Stable key of the entry; interaction state survives enrichment and refinement. */
  readonly key: string;
  readonly target: UiEntryTarget;
  /** Basic information resolved with the page, or null for an explicit unresolved entry. */
  readonly basic: UiEntryBasic | null;
  /** Quantity context the source evaluated; null when it carries none. */
  readonly quantity: UiEntryQuantity | null;
}

/** Query context one source evaluates; the adapting page owns its concrete shape. */
export interface UiListRequest<Context> {
  readonly context: Context;
  readonly pageSize: number;
  /** Opaque continuation of the next page, or null to start the result. */
  readonly continuation: string | null;
  /** Cancelling it withdraws the request; a withdrawn page is never presented. */
  readonly signal: AbortSignal;
}

export interface UiListPage {
  readonly entries: readonly UiListEntry[];
  /** Opaque continuation of the next page, or null when this page ends the result. */
  readonly continuation: string | null;
}

/** A source supplies entries, the end of the result and access to further pages. */
export interface UiListSource<Context = unknown> {
  load(request: UiListRequest<Context>): Promise<UiListPage>;
}

/**
 * Information a fragment request asks for. Each kind loads, refreshes and fails independently of
 * the basic entry information and of the other kinds (docs/user-interface.md#cardlist).
 */
export const uiFragmentKinds = ['images', 'ownership', 'tags', 'tools'] as const;

export type UiFragmentKind = (typeof uiFragmentKinds)[number];

/** Enrichment request for explicit entry keys. */
export interface UiFragmentRequest {
  readonly keys: readonly string[];
  readonly information: readonly UiFragmentKind[];
  readonly signal: AbortSignal;
}

/**
 * One entry's enrichment outcome for the requested information. `ready` carries the resolved
 * information, `absent` is a definitive empty answer and `failed` a reported failure; a failed
 * fragment is never presented as an empty result. The value shape stays with the adapting page.
 */
export type UiFragmentResult<Value = unknown> =
  | { readonly key: string; readonly status: 'ready'; readonly values: Value }
  | { readonly key: string; readonly status: 'absent'; readonly values: null }
  | { readonly key: string; readonly status: 'failed'; readonly message: string };

/** Reads the requested information for explicit entry keys. */
export interface UiFragmentReader<Value = unknown> {
  read(request: UiFragmentRequest): Promise<readonly UiFragmentResult<Value>[]>;
}

/** Selection context one tool invocation acts on; it is explicit, never inferred from the view. */
export interface UiToolSelection {
  /** Stable keys of the selected entries. */
  readonly keys: readonly string[];
  /** Typed targets of the selected entries, aligned with `keys`. */
  readonly targets: readonly UiEntryTarget[];
}

/** One user action over explicit targets through the owning component's operation. */
export interface UiToolRequest {
  readonly targets: readonly UiEntryTarget[];
  readonly selection: UiToolSelection;
  readonly signal: AbortSignal;
}

/**
 * Result of one tool invocation. Pages present a saved outcome only for `committed`, keep unsaved
 * input after `conflict` and `failed`, and recover the recorded outcome of an `unknown` one
 * (docs/user-interface.md#browsing-and-organization).
 */
export interface UiOperationOutcome {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  /** User-facing explanation, or null when no further explanation helps. */
  readonly message: string | null;
}

export interface UiTool {
  /**
   * Invokes the operation for the explicit targets. A rejection carries no receipt, so the caller
   * reports its outcome as unknown; a definite failure is the operation's own `failed` outcome.
   */
  invoke(request: UiToolRequest): Promise<UiOperationOutcome>;
}
