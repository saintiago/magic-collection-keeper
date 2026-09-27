/**
 * Bounds the UserInterface enforces (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation, docs/user-interface.md#list-boundary). Routes, the
 * interaction state kept for history entries and the working set of one CardList are bounded so a
 * hostile or broken view cannot grow presentation state without limit.
 */
export const UI_LIMITS = {
  /** Characters one route segment may carry before it is rejected. */
  routeSegment: 128,
  /** History entries whose captured interaction state the shell keeps for restoration. */
  viewStates: 20,
  /** Keys one captured restoration state may carry. */
  restorationKeys: 32,
  /** Characters one captured text value may carry. */
  restorationText: 500,
  /** Values one captured identity list may carry. */
  restorationList: 100,
  /** Entries one CardList request asks a source for at most. */
  listPage: 100,
  /** Items one entry's fragment result may present, so a broken source cannot grow one row. */
  fragmentItems: 20,
} as const;
