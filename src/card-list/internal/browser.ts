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

import type { SearchIndexingProgress } from '../../search/browser.js';
import type { CardRecord, Catalog } from '../../catalog/index.js';
import type { UserCardsAccountOperations, UserCardsChange } from '../../usercards/browser.js';

import type {
  CardList,
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
  pickerQuerySource,
  searchCounts,
  type CardListCatalogQuery,
  type CardListCollectionQuery,
  type CardListCountsRead,
  type CardListCountsAccess,
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
  /** Account-lifetime progress supplied by Application from Search. */
  readonly progress: (accountId: string) => Pick<SearchIndexingProgress, 'status'>;
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
  /** Advisory tools for copies whose continued existence the provider establishes. */
  copyTools(ids: readonly string[]): CardListFragmentReader<readonly string[]>;
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
  /** Releases one account's local bindings and activity when the account ends. */
  endAccount(accountId: string): void;
}

/** Account-local history and derived-count invalidation; Search owns indexing progress. */
interface AccountScope {
  readonly recent: CardListRecentActivity;
  readonly counts: CardListCountsAccess;
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
        counts: searchCounts(search),
      };
      scopes.set(accountId, account);
    }
    return account;
  }

  function changesOf(accountId: string): CardListChangeSource {
    const progress = options.progress(accountId);
    const changes = usercardsChanges(userCards.account(accountId));
    return {
      subscribe(listener) {
        const unsubscribe = changes.subscribe(listener);
        for (const position of progress.status().outstanding) {
          listener({ scope: 'copies', records: [], imports: [], position });
        }
        return unsubscribe;
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
      const counts = account.counts;
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
        copyTools: (ids) => ({
          async read(request) {
            const copyIds = request.keys
              .filter((key) => key.startsWith('copy:'))
              .map((key) => key.slice(5));
            const present = new Set<string>();
            const bound = facade().constraints.batch.references;
            for (let index = 0; index < copyIds.length; index += bound) {
              const result = await facade().readCopies(
                copyIds.slice(index, index + bound),
                request.signal,
              );
              for (const id of result.copies.keys()) present.add(id);
            }
            return request.keys.map((key) => ({
              key,
              status: 'ready' as const,
              values: key.startsWith('copy:') && present.has(key.slice(5)) ? ids : [],
            }));
          },
        }),
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
            search,
          }),
      };
    },
    endAccount(accountId) {
      const account = scopes.get(accountId);
      if (account === undefined) {
        return;
      }
      account.recent.clear(accountId);
      scopes.delete(accountId);
    },
  };
}

export type { UserCardsChange };
