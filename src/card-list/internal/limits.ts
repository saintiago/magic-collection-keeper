/**
 * Bounds CardList enforces on its own work (docs/card-list.md#internal-design).
 *
 * A list acquires only the active working set, so the page size a source is asked for, the window
 * the list keeps, the enrichment batch it reads and the activity history it records are all
 * bounded here. A page's own drafts, routes and editor state stay bounded by their owner.
 */
export const CARD_LIST_LIMITS = {
  /** Characters one entry key or target identity may carry before the source answer is rejected. */
  entryKey: 500,
  /** Entries one list request asks a source for at most. */
  page: 100,
  /** Entries one list keeps in its working set; further results slide the window forward. */
  window: 500,
  /** Entry keys one fragment request asks a reader for at most. */
  fragmentBatch: 100,
  /** Items one entry's fragment result may present, so a broken source cannot grow one row. */
  fragmentItems: 20,
  /**
   * References one Catalog resolve request carries. The provider's own accepted bound stays with
   * the Catalog contract, so a binding resolves a larger set in further requests.
   */
  resolveBatch: 100,
  /** Characters one committed publication position may carry while it awaits incorporation. */
  position: 100,
  /**
   * Committed positions one list tracks while they await incorporation. A longer backlog keeps
   * the newest, so observation work and retained state stay bounded; the provider establishes
   * every position a read or observation is given.
   */
  awaitingPositions: 50,
  /** Recent card entries one account's activity keeps, most recent first. */
  recentCards: 24,
} as const;
