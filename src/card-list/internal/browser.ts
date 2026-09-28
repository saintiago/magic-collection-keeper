/**
 * Browser composition of CardList (docs/architecture.md#composition-and-replacement,
 * docs/tech-stack.md#component-boundaries).
 *
 * Application assembles one of these over the authenticated provider clients it already supplies
 * and hands it to the UserInterface, so page and view code describes its activity and receives a
 * list without naming this component's implementation, sources or fragment readers. The factory
 * inside is the component's own default; another implementation of the same contract can replace it
 * without touching a page. All bindings consume provider-owned contracts, and the account-scoped
 * parts (committed-change subscriptions and local recent activity) follow the supplied account.
 */

import type { CardRecord, Catalog } from '../../catalog/index.js';
import type { UserCardsAccountOperations, UserCardsChange } from '../../usercards/browser.js';

import type {
  CardList,
  CardListChange,
  CardListChangeSource,
  CardListEntry,
  CardListEntryImage,
  CardListEntryOwnership,
  CardListFragmentReader,
  CardListOptions,
  CardListSource,
} from './contract.js';
import { createCardList } from './list.js';
import {
  catalogQuerySource,
  collectionQuerySource,
  entryOwnershipReader,
  observeSearchProgress,
  pickerQuerySource,
  searchCounts,
  type CardListCatalogQuery,
  type CardListCollectionQuery,
  type CardListCountsRead,
  type CardListPickerQuery,
  type CardListSearchRead,
} from './bindings/search.js';
import { cardPrintingsSource, printingImagesReader } from './bindings/catalog.js';
import { usercardsChanges } from './bindings/usercards.js';
import { pendingEntriesBinding, type CardListPendingEntries } from './bindings/pending.js';
import { tagAssociationsBinding, type CardListTagAssociations } from './bindings/associations.js';
import { createRecentActivity, type CardListRecentActivity } from './recent.js';

/** The provider capabilities one browser composition of CardList consumes. */
export interface CardListBrowserOptions {
  /** Search's query, private-count and bounded-freshness capabilities. */
  readonly search: CardListSearchRead & CardListCountsRead;
  /** Catalog's resolution and printing capabilities. */
  readonly catalog: Catalog;
  /** UserCards' account-scoped browser operations, pending imports and associations. */
  readonly userCards: {
    account(accountId: string): UserCardsAccountOperations;
  };
}

/** One account's recent card activity as the pages that present it consume it. */
export interface CardListRecentBinding {
  /** The list source of the account's recent cards, most recent first. */
  readonly source: CardListSource<string>;
  /** Records one entry the account explicitly opened. */
  record(entry: CardListEntry): void;
}

/**
 * Account-scoped bindings of the lists one page describes: Search queries, Catalog printings and
 * images, private ownership counts, pending imports, tag associations, committed changes and the
 * account's local recent activity. Pages supply intent and presentation only.
 */
export interface CardListAccountBindings {
  /** The account these bindings belong to. */
  readonly accountId: string;
  /** Committed-change notifications of the account, including its outstanding progress. */
  changes(): CardListChangeSource;
  /** The account's local recent card activity. */
  recent(): CardListRecentBinding;
  catalogQuery(): CardListSource<CardListCatalogQuery>;
  collectionQuery(): CardListSource<CardListCollectionQuery>;
  pickerQuery(): CardListSource<CardListPickerQuery>;
  cardPrintings(card: CardRecord): CardListSource<string>;
  printingImages(): CardListFragmentReader<readonly CardListEntryImage[]>;
  /** Ownership counts of explicit entries, optionally with one tag's intended quantity. */
  ownership(tagId: string | null): CardListFragmentReader<CardListEntryOwnership>;
  /** The pending entries of one import, with the provider records its page reviews. */
  pendingEntries(): CardListPendingEntries;
  /** The associations of one tag, with the provider records its editors review. */
  tagAssociations(tagId: string): CardListTagAssociations;
}

/**
 * The CardList capability Application supplies to the UserInterface: one replaceable factory and
 * the provider bindings of the account the consumer presents.
 */
export interface CardListBrowser {
  /** Creates one headless list over the supplied description. */
  create<Context>(options: CardListOptions<Context>): CardList<Context>;
  /** Provider bindings of one presented account; each account gets its own scope. */
  account(accountId: string): CardListAccountBindings;
  /** Releases one account's local activity and remembered progress when the account ends. */
  endAccount(accountId: string): void;
}

/** One account's remembered state: its activity store and the positions still awaiting indexing. */
interface AccountScope {
  readonly recent: CardListRecentActivity;
  /** Positions known committed and not yet established as incorporated, oldest first. */
  outstanding: readonly string[];
  /** Subscribers of the account's committed changes; the facade subscription lives while any does. */
  readonly listeners: Set<(change: CardListChange) => void>;
  unsubscribe: (() => void) | null;
  /** Withdraws the composition's own bounded observation of the outstanding positions. */
  observation: AbortController | null;
}

/**
 * Builds Application's CardList capability over the provider clients of one browser runtime.
 * Account-scoped bindings are composed on demand; no authenticated client or concrete provider is
 * constructed here.
 */
export function createCardListBrowser(options: CardListBrowserOptions): CardListBrowser {
  const search = options?.search;
  if (typeof search?.execute !== 'function') {
    throw new TypeError('The CardList browser composition reads queries through Search.');
  }
  const catalog = options?.catalog;
  if (typeof catalog?.resolve !== 'function' || typeof catalog.listCardPrintings !== 'function') {
    throw new TypeError(
      'The CardList browser composition reads cards and printings through Catalog.',
    );
  }
  const userCards = options?.userCards;
  if (typeof userCards?.account !== 'function') {
    throw new TypeError(
      'The CardList browser composition reads private records through UserCards.',
    );
  }
  const scopes = new Map<string, AccountScope>();

  function scope(accountId: string): AccountScope {
    let account = scopes.get(accountId);
    if (account === undefined) {
      account = {
        recent: createRecentActivity(),
        outstanding: [],
        listeners: new Set(),
        unsubscribe: null,
        observation: null,
      };
      scopes.set(accountId, account);
    }
    return account;
  }

  /**
   * Checks the positions the composition remembers against Search's own bounded observation and
   * forgets the ones it established, so a list composed later is not told to await progress the
   * index already holds. A delayed, failed or unavailable check keeps the positions: an unknown
   * status is never treated as incorporation.
   */
  function checkOutstanding(account: AccountScope, accountId: string): void {
    if (account.observation !== null || account.outstanding.length === 0) {
      return;
    }
    if (typeof search.observe !== 'function') {
      return;
    }
    const positions = [...account.outstanding];
    const controller = new AbortController();
    account.observation = controller;
    observeSearchProgress(search, positions, controller.signal).then(
      (observed) => {
        if (account.observation !== controller) {
          return;
        }
        account.observation = null;
        if (observed !== 'incorporated') {
          return;
        }
        const established = new Set(positions);
        account.outstanding = account.outstanding.filter((position) => !established.has(position));
        checkOutstanding(account, accountId);
      },
      () => {
        if (account.observation === controller) {
          account.observation = null;
        }
      },
    );
  }

  /**
   * The account's committed-change source. It subscribes to the account's own UserCards facade
   * once, remembers every publication position the notifications named and replays the positions
   * still outstanding to a list that subscribes later, so reopening or newly composing a list never
   * turns a known committed change into an apparently current result. A list whose own read or
   * observation establishes the positions keeps its requirement private to itself, but the
   * composition keeps the account's outstanding set until it observes incorporation.
   */
  function changesOf(accountId: string): CardListChangeSource {
    const account = scope(accountId);
    const facade = userCards.account(accountId);
    return {
      subscribe(listener) {
        if (typeof listener !== 'function') {
          throw new TypeError('A CardList change subscriber is a function.');
        }
        if (account.listeners.size === 0) {
          const upstream = usercardsChanges(facade).subscribe((change) => {
            if (change.position !== null && !account.outstanding.includes(change.position)) {
              account.outstanding = [...account.outstanding, change.position];
              checkOutstanding(account, accountId);
            }
            for (const subscriber of [...account.listeners]) {
              subscriber(change);
            }
          });
          account.unsubscribe = upstream;
        }
        account.listeners.add(listener);
        // The new list reacquires every position the account still awaits. The notifications carry
        // no records, so only the query lists that re-read through Search treat them as affected.
        for (const position of [...account.outstanding]) {
          listener({ scope: 'copies', records: [], imports: [], position });
        }
        return () => {
          account.listeners.delete(listener);
          if (account.listeners.size === 0) {
            account.unsubscribe?.();
            account.unsubscribe = null;
          }
        };
      },
    };
  }

  return {
    create: (listOptions) => createCardList(listOptions),
    account(accountId) {
      if (typeof accountId !== 'string' || accountId.length === 0) {
        throw new TypeError('The CardList bindings belong to one verified account.');
      }
      const account = scope(accountId);
      const facade = () => userCards.account(accountId);
      const counts = searchCounts(search);
      return {
        accountId,
        changes: () => changesOf(accountId),
        recent: () => ({
          source: account.recent.source(accountId),
          record: (entry) => account.recent.record(accountId, entry),
        }),
        catalogQuery: () => catalogQuerySource(search),
        collectionQuery: () => collectionQuerySource(search),
        pickerQuery: () => pickerQuerySource(search),
        cardPrintings: (card) => cardPrintingsSource(catalog, card),
        printingImages: () => printingImagesReader(catalog),
        ownership: (tagId) => entryOwnershipReader(counts, undefined, () => tagId),
        pendingEntries: () =>
          pendingEntriesBinding({
            entries: {
              entries: (input, signal) => facade().listImportEntries(input, signal),
            },
            catalog,
          }),
        tagAssociations: (tagId) =>
          tagAssociationsBinding({
            tagId,
            read: {
              constraints: facade().constraints,
              associations: (readTagId, readOptions, signal) =>
                facade().listAssociations(readTagId, readOptions, signal),
              readCopies: (copyIds, signal) => facade().readCopies(copyIds, signal),
            },
            catalog,
            counts,
          }),
      };
    },
    endAccount(accountId) {
      const account = scopes.get(accountId);
      if (account === undefined) {
        return;
      }
      account.observation?.abort();
      account.observation = null;
      account.unsubscribe?.();
      account.unsubscribe = null;
      account.listeners.clear();
      account.recent.clear(accountId);
      account.outstanding = [];
      scopes.delete(accountId);
    },
  };
}

export type { UserCardsChange };
