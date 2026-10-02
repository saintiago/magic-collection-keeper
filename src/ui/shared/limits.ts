import { CARD_LIST_LIMITS } from '../../card-list/index.js';

/**
 * Bounds the UserInterface enforces (docs/ui/architecture.md#load-time-and-rendering,
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
   * copy and tag references and Catalog references all accept at most 200 characters
   * (docs/catalog.md#identities-and-information, docs/user-cards.md#interface), so every result a
   * provider can publish renders and opens instead of being rejected as a link.
   */
  routeSegment: 200,
  /** History entries whose opaque retained state the shell keeps for restoration. */
  viewStates: 20,
  /** Characters one entry key or target identity may carry; CardList owns the list bound. */
  entryKey: CARD_LIST_LIMITS.entryKey,
  /** Characters one browsing text expression (a catalog or collection query) may carry. */
  catalogQuery: 500,
  /**
   * Entries one browsing, collection or organization page asks its list for. The page picks a
   * bound within the list's own page bound, so a page of a provider result stays small.
   */
  catalogPage: 50,
  /** Printings one page of a card's published printings asks the Catalog contract for. */
  printingPage: 100,
  /** Recent card entries one account's activity keeps, most recent first. */
  recentCards: CARD_LIST_LIMITS.recentCards,
  /** Entries one list request asks a source for at most. */
  listPage: CARD_LIST_LIMITS.page,
  /** Entries one list keeps in its working set; further results slide it forward. */
  listWindow: CARD_LIST_LIMITS.window,
  /** Entry keys one fragment request asks a reader for at most. */
  fragmentBatch: CARD_LIST_LIMITS.fragmentBatch,
  /** Items one entry's fragment result may present, so a broken source cannot grow one row. */
  fragmentItems: CARD_LIST_LIMITS.fragmentItems,
  /** Printings one page of a manual entry search asks Catalog for. */
  importPrintings: 20,
  /**
   * References one Catalog resolve request carries. The provider's own accepted bound is
   * published by the Catalog contract, whose barrel is not browser-safe, so the page sizes its
   * requests itself within that bound and a larger set is resolved in further requests.
   */
  catalogResolveBatch: CARD_LIST_LIMITS.resolveBatch,
} as const;
