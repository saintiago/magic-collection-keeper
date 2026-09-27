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
  /** Characters one browsing text expression (a catalog or collection query) may carry. */
  catalogQuery: 500,
  /** Entries one catalog page asks the Search contract for. */
  catalogPage: 50,
  /** Printings one page of a card's published printings asks the Catalog contract for. */
  printingPage: 100,
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
  /** Tags one page of the tags page asks the UserCards contract for. */
  tagPage: 50,
  /** Associations one page of a tag view asks the UserCards contract for. */
  associationPage: 50,
  /** Pending import entries one page of the Import page asks UserCards for. */
  importPage: 50,
  /** Pending import sessions one page of the Import page asks UserCards for. */
  importSessions: 50,
  /**
   * Pending import entries one staging or confirmation request carries. The bound mirrors the
   * provider's own bound for those changes, so an explicit selection larger than one request is
   * decided through further bounded requests instead of being rejected by the provider.
   */
  importBatch: 50,
  /** Printings one page of a manual entry search asks Search for. */
  importPrintings: 20,
  /**
   * Copy references one private copy read asks for at most. The bound mirrors the copy references
   * a UserCards read accepts, so a selection larger than one read is read in further bounded
   * batches instead of being rejected by the provider.
   */
  copyBatch: 100,
} as const;
