/**
 * Bounds the UserInterface enforces (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation, docs/user-interface.md#list-boundary,
 * docs/user-interface.md#browsing-and-organization). Routes and the history entries the shell
 * keeps are bounded, and each owner bounds the state it retains itself: the shell never interprets
 * or restricts the page state a history entry holds, and the browsing pages bound their own draft,
 * query and recent-activity state (docs/user-interface.md#state-ownership-and-restoration).
 */
export const UI_LIMITS = {
  /**
   * Characters one route segment may carry before it is rejected. The bound covers the longest
   * identity the components a route names publish: Catalog card/printing references, UserCards
   * copy and tag references and Search references all accept at most 200 characters
   * (docs/catalog.md#identities-and-information, docs/user-cards.md#interface), so every result a
   * provider can publish renders and opens instead of being rejected as a link.
   */
  routeSegment: 200,
  /** History entries whose opaque retained state the shell keeps for restoration. */
  viewStates: 20,
  /** Characters one entry key or target identity may carry before the source answer is rejected. */
  entryKey: 500,
  /** Characters one catalog search expression may carry before the route is rejected. */
  catalogQuery: 500,
  /** Entries one catalog page asks the Search contract for. */
  catalogPage: 50,
  /** Recent card entries Home presents for one account, most recent first. */
  recentCards: 24,
  /** Entries one CardList request asks a source for at most. */
  listPage: 100,
  /** Entries one CardList renders in its working set; further results slide it forward. */
  listWindow: 500,
  /** Entry keys one CardList fragment request asks a reader for at most. */
  fragmentBatch: 100,
  /** Items one entry's fragment result may present, so a broken source cannot grow one row. */
  fragmentItems: 20,
} as const;
