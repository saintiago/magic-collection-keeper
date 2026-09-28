/**
 * CardList public entry point (docs/card-list.md#interface,
 * docs/card-list.md#required-interfaces-and-source-bindings, docs/architecture.md#components).
 *
 * The component owns one list's asynchronous contents, enrichment, selection, working window,
 * restoration, account-local recent activity and freshness handling, and it provides a
 * presentation model independent of a DOM, page, transport or storage implementation. A consumer
 * describes one activity — a Search query, an owned-collection query, a card's published
 * printings, a picker search or the account's recent cards — with the source its binding supplies,
 * and receives an independently constructed list that publishes immutable snapshots.
 *
 * Bindings live in this component and translate provider results into the list's own
 * source/fragment protocol: Search supplies query membership, ordering, grouping, continuation,
 * counts and freshness; Catalog supplies printing pages, batched basic information and image
 * references; UserCards supplies pending-entry lists, tags, operation availability and the
 * committed-change notifications a list reacquires from. Bindings are replaceable separately from
 * window and selection behavior by supplying another source or fragment reader. Providers never
 * import these presentation types.
 *
 * CardList runs in the browser without a rendering dependency: a presentation supplies the
 * container, renders snapshots and reports viewport demand, user intent and its logical position
 * through this contract. UserInterface consumes the component through this module only; its
 * internal modules stay private to the component (docs/architecture.md, .dependency-cruiser.mjs).
 */

export { CARD_LIST_LIMITS } from './internal/limits.js';
export { createCardList, groupCardListEntries } from './internal/list.js';
export { createRecentActivity, type CardListRecentActivity } from './internal/recent.js';
export {
  createCardListBrowser,
  type CardListAccountBindings,
  type CardListBrowser,
  type CardListBrowserOptions,
  type CardListRecentBinding,
} from './internal/browser.js';
export {
  pendingEntriesBinding,
  pendingEntryKey,
  pendingListEntry,
  type CardListPendingEntries,
  type CardListPendingEntriesRead,
  type CardListPendingRecord,
} from './internal/bindings/pending.js';
export {
  associationKey,
  associationListEntry,
  referenceOfAssociation,
  tagAssociationsBinding,
  type CardListTagAssociations,
  type CardListTagAssociationsRead,
} from './internal/bindings/associations.js';
export {
  catalogQueryRequest,
  catalogQuerySource,
  cardListEntryKey,
  cardListTargetOfKey,
  collectionQueryRequest,
  collectionQuerySource,
  entryOwnershipReader,
  isInvalidatedContinuation,
  observeSearchProgress,
  pickerQuerySource,
  readFailureCode,
  readableSearchPage,
  searchCounts,
  searchEntryOf,
  type CardListCountsAccess,
  type CardListCountsRead,
  type CardListEntryCounts,
  type CardListSearchRead,
  type CardListCatalogQuery,
  type CardListCollectionQuery,
  type CardListPickerQuery,
} from './internal/bindings/search.js';
export {
  cardPrintingsSource,
  printingEntry,
  printingIdOfEntryKey,
  printingImagesReader,
  resolveCards,
  resolvePrintings,
} from './internal/bindings/catalog.js';
export { usercardsChanges, type CardListUserCardsChanges } from './internal/bindings/usercards.js';
export {
  cardListFragmentKinds,
  type CardList,
  type CardListChange,
  type CardListChangeSource,
  type CardListEntry,
  type CardListEntryBasic,
  type CardListEntryCard,
  type CardListEntryImage,
  type CardListEntryOwnership,
  type CardListEntryPrinting,
  type CardListEntryQuantity,
  type CardListEntrySnapshot,
  type CardListEntryTag,
  type CardListFocus,
  type CardListFragmentKind,
  type CardListFragmentReader,
  type CardListFragmentReaders,
  type CardListFragmentRequest,
  type CardListFragmentResult,
  type CardListFragmentState,
  type CardListGroup,
  type CardListIndexingStatus,
  type CardListObservation,
  type CardListObservationRequest,
  type CardListOperationOutcome,
  type CardListOptions,
  type CardListPage,
  type CardListPosition,
  type CardListPositionReport,
  type CardListRead,
  type CardListRequiredProgress,
  type CardListRestoration,
  type CardListRetained,
  type CardListSelectedTarget,
  type CardListSelection,
  type CardListSnapshot,
  type CardListSource,
  type CardListSourceRequest,
  type CardListTarget,
  type CardListTool,
  type CardListToolRequest,
  type CardListToolSelection,
  type CardListToolState,
  type CardListViewportDemand,
} from './internal/contract.js';
