/**
 * Search bindings of CardList (docs/card-list.md#required-interfaces-and-source-bindings,
 * docs/search.md#scryfall-compatibility, docs/search.md#freshness).
 *
 * A query description becomes one Search request: the text expression and the structured controls
 * normalize into the same query model, the opaque continuation of a page returns unchanged, and a
 * continuation the provider invalidated is reported as an invalidated sequence instead of failing
 * the read temporarily. Entries keep the provider's membership, ordering, typed targets, basic
 * information and quantity context; the images fragment of a printing entry is read through
 * Catalog and the private counts fragment through Search's counts read, both separately from the
 * basic information.
 *
 * A committed publication position a list requires is passed to Search as the position the answer
 * must have incorporated: a usable answer that has not incorporated it is presented as still
 * updating, and an answer without a usable result fails as a retryable read rather than becoming an
 * empty result.
 */

import type {
  SearchCount,
  SearchCountInput,
  SearchCountReference,
  SearchCountResult,
  SearchCriterion,
  SearchEntry,
  SearchPage,
  SearchProgress,
  SearchProgressRequest,
  SearchRequestInput,
  SearchResultLevel,
  SearchObservationOptions,
} from '../../../search/index.js';
import type { Finish } from '../../../catalog/index.js';
import { SEARCH_LIMITS } from '../../../search/browser.js';
import { SEARCH_PROGRESS_DEFAULT_WINDOW_MS } from '../../../search/browser.js';

import type {
  CardListEntry,
  CardListEntryImage,
  CardListEntryOwnership,
  CardListFragmentReader,
  CardListObservation,
  CardListObservationRequest,
  CardListSource,
  CardListSourceRequest,
  CardListTarget,
} from '../contract.js';

/**
 * The Search read a list binding consumes. Application supplies the contract of the interactive
 * entry point; CardList depends on Search's own request and result vocabulary so a replacement
 * implementation can serve it.
 */
export interface CardListSearchRead {
  execute(request: SearchRequestInput, signal?: AbortSignal): Promise<SearchPage>;
  /**
   * Search's bounded freshness capability (docs/search.md#freshness). It establishes the explicit
   * committed positions the answer names; a read that cannot establish every position it required
   * reports its page as still updating instead of caught up. Optional: without it a list rechecks
   * through a read and a multi-position requirement is never reported as incorporated.
   */
  observe?(
    request: SearchProgressRequest,
    options: SearchObservationOptions,
  ): Promise<SearchProgress>;
}

/** The private counts read a list binding consumes. */
export interface CardListCountsRead {
  counts(request: SearchCountInput, signal?: AbortSignal): Promise<SearchCountResult>;
}

/** One catalog query: the text expression and the structured controls a page presents. */
export interface CardListCatalogQuery {
  /** Scryfall-compatible text expression; empty browses the whole catalog. */
  readonly text: string;
  readonly level: SearchResultLevel;
  /** Whether the account must own the physical copies the entry represents. */
  readonly owned: boolean;
  /** Required printing finish, or null when the query does not constrain it. */
  readonly finish: Finish | null;
}

/**
 * One collection query: the text expression and the level of the account's owned records. The
 * owned membership is not a control of this query — every collection entry is owned — so the
 * binding always evaluates it as the private criterion it is.
 */
export interface CardListCollectionQuery {
  /** Scryfall-compatible text expression; empty presents every owned entry of the level. */
  readonly text: string;
  readonly level: SearchResultLevel;
}

/** One selectable entry of a tag or association picker: a search over one result level. */
export interface CardListPickerQuery {
  readonly text: string;
  readonly level: SearchResultLevel;
}

/**
 * One Search request for a catalog query and a page boundary. The controls become structured
 * criteria and the text expression stays one expression, so Search normalizes both into the same
 * query model; the continuation names the page of the query that produced it.
 */
export function catalogQueryRequest(
  query: CardListCatalogQuery,
  pageSize: number,
  continuation: string | null,
  requiredPosition: string | null = null,
): SearchRequestInput {
  const criteria: SearchCriterion[] = [];
  if (query.owned) {
    criteria.push({ kind: 'owned' });
  }
  if (query.finish !== null) {
    criteria.push({ kind: 'finish', finish: query.finish });
  }
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text.length === 0 ? {} : { query: text }),
    ...(criteria.length === 0 ? {} : { criteria }),
    pageSize,
    ...(continuation === null ? {} : { continuation }),
    ...(requiredPosition === null ? {} : { requiredPosition }),
  };
}

/**
 * One Search request for a collection query and a page boundary: the text expression stays one
 * expression beside the owned criterion, so Search normalizes it into the same query model a
 * catalog query with the owned control uses, and the opaque continuation names the page of the
 * account-scoped query that produced it.
 */
export function collectionQueryRequest(
  query: CardListCollectionQuery,
  pageSize: number,
  continuation: string | null,
  requiredPosition: string | null = null,
): SearchRequestInput {
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text.length === 0 ? {} : { query: text }),
    criteria: [{ kind: 'owned' }],
    pageSize,
    ...(continuation === null ? {} : { continuation }),
    ...(requiredPosition === null ? {} : { requiredPosition }),
  };
}

/** The catalog query's list source over the Search read. */
export function catalogQuerySource(
  search: CardListSearchRead,
): CardListSource<CardListCatalogQuery> {
  return createSearchSource(search, catalogQueryRequest);
}

/** The collection query's list source over the Search read. */
export function collectionQuerySource(
  search: CardListSearchRead,
): CardListSource<CardListCollectionQuery> {
  return createSearchSource(search, collectionQueryRequest);
}

/**
 * The picker source of one tag or association form: the result level's search, restricted to the
 * account's owned copies when the level presents physical copies.
 */
export function pickerQuerySource(search: CardListSearchRead): CardListSource<CardListPickerQuery> {
  return createSearchSource(search, (query, pageSize, continuation, requiredPosition) => {
    const text = query.text.trim();
    return {
      resultLevel: query.level,
      ...(text.length === 0 ? {} : { query: text }),
      ...(query.level === 'copy' ? { criteria: [{ kind: 'owned' as const }] } : {}),
      pageSize,
      ...(continuation === null ? {} : { continuation }),
      ...(requiredPosition === null ? {} : { requiredPosition }),
    };
  });
}

/**
 * One Search-backed list source: the binding builds the request of its own presentation contract
 * and keeps the provider's answer, so the list presents the membership, ordering and continuation
 * Search evaluated rather than reconstructing them.
 */
function createSearchSource<Context>(
  search: CardListSearchRead,
  build: (
    context: Context,
    pageSize: number,
    continuation: string | null,
    requiredPosition: string | null,
  ) => SearchRequestInput,
): CardListSource<Context> {
  if (typeof search?.execute !== 'function') {
    throw new TypeError('A CardList query is read through the Search contract.');
  }
  const observe = search.observe;
  return {
    async load(request: CardListSourceRequest<Context>) {
      let page: SearchPage;
      try {
        page = readableSearchPage(
          readSearchPage(
            await search.execute(
              build(
                request.context,
                request.pageSize,
                request.continuation,
                requiredPosition(request),
              ),
              request.signal,
            ),
          ),
        );
      } catch (cause) {
        if (request.continuation !== null && isInvalidatedContinuation(cause)) {
          // Search bound the continuation to the revisions its query used; the changed revisions
          // invalidate the sequence instead of failing this read temporarily, so the list restarts
          // it from its first page (docs/search.md#request-and-result).
          return { status: 'invalidated' };
        }
        throw cause;
      }
      // The page's own status answers the one position the request carried. Every further known
      // committed position is established through Search's own bounded observation, so a page that
      // incorporated an older position never clears a newer one that is still indexing
      // (docs/search.md#freshness).
      const current =
        page.status === 'ready' &&
        (await requiredIncorporated(search, request.required.positions, request.signal));
      return {
        status: 'page',
        entries: page.entries.map((entry) => searchEntryOf(entry)),
        continuation: page.continuation,
        current,
      };
    },
    ...(typeof observe === 'function'
      ? {
          observe: (request: CardListObservationRequest) =>
            observeSearchProgress(search, request.positions, request.signal),
        }
      : {}),
    // Every committed change may alter the membership, ordering or quantities of a query, so a
    // Search-backed list reacquires its result for any notification it is handed.
    affects: () => true,
  };
}

/**
 * Position the query request itself waits for. Search accepts one required position per query, so
 * the binding names the most recently reported one for its own wait and establishes the whole set
 * separately: notification order never proves which positions the indexed generation holds.
 */
function requiredPosition(request: CardListSourceRequest<unknown>): string | null {
  const positions = request.required.positions;
  if (!Array.isArray(positions) || positions.length === 0) {
    return null;
  }
  const latest = positions[positions.length - 1];
  return typeof latest === 'string' && latest.length > 0 ? latest : null;
}

/**
 * Whether the provider established every required position. A single position is answered exactly
 * by the query's own status; further positions are read through Search's bounded observation in
 * bounded batches. Without the observation capability a multi-position requirement is never
 * reported as incorporated, because no provider read established it.
 */
async function requiredIncorporated(
  search: CardListSearchRead,
  positions: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (positions.length === 0 || positions.length === 1) {
    return true;
  }
  if (typeof search.observe !== 'function') {
    return false;
  }
  for (const batch of positionBatches(positions)) {
    const observed = await search.observe({ positions: batch }, { timeoutMs: 0, signal });
    if (observed.state !== 'incorporated') {
      return false;
    }
  }
  return true;
}

/**
 * One bounded observation of the awaited positions through Search's freshness capability. Each
 * batch is observed within the declared window; incorporation of one batch never stands for
 * another, so the observation reports incorporated only once every batch is established.
 */
export async function observeSearchProgress(
  search: CardListSearchRead,
  positions: readonly string[],
  signal: AbortSignal,
): Promise<CardListObservation> {
  const observe = search.observe;
  if (typeof observe !== 'function' || positions.length === 0) {
    return 'delayed';
  }
  let observed: CardListObservation = 'incorporated';
  for (const batch of positionBatches(positions)) {
    const progress = await observe(
      { positions: batch },
      { timeoutMs: SEARCH_PROGRESS_DEFAULT_WINDOW_MS, signal },
    );
    if (progress.state === 'failed') {
      return 'failed';
    }
    if (progress.state !== 'incorporated') {
      observed = 'delayed';
    }
  }
  return observed;
}

/** Bounded batches of explicit positions, as the provider's observation capability accepts them. */
function positionBatches(positions: readonly string[]): readonly (readonly string[])[] {
  const bound = SEARCH_LIMITS.maxRequiredPositions;
  const batches: string[][] = [];
  for (let index = 0; index < positions.length; index += bound) {
    batches.push(positions.slice(index, index + bound));
  }
  return batches;
}

/**
 * One Search result a consumer may present, or a retryable failure when the index has no complete
 * answer to present yet. A result that reports updating without a usable total count has no usable
 * answer: presenting its absent entries would claim the account's search holds no match, so the
 * read fails and the consumer can retry it instead (docs/search.md#freshness,
 * docs/data-architecture.md#freshness-and-user-visible-behavior).
 */
export function readableSearchPage(page: SearchPage): SearchPage {
  if (page.status === 'updating' && page.totalCount === null) {
    throw new Error('The search results are still being indexed.');
  }
  return page;
}

/** One Search entry as the list protocol presents it. */
export function searchEntryOf(entry: SearchEntry): CardListEntry {
  const printing = entry.printing;
  return {
    key: cardListEntryKey(entry.target),
    target: entry.target,
    basic: {
      card: {
        cardId: entry.card.cardId,
        name: entry.card.name,
        matchedName: entry.card.matchedName,
      },
      printing:
        printing === null
          ? null
          : {
              printingId: printing.printingId,
              edition: printing.edition,
              collectorNumber: printing.collectorNumber,
              language: printing.language,
            },
    },
    quantity: entry.quantity,
  };
}

/**
 * Key of one presented entry: its level and its provider identity. The list keeps interaction
 * state under it, and a fragment read names the entry's printing from the key alone.
 */
export function cardListEntryKey(target: CardListTarget): string {
  switch (target.kind) {
    case 'card':
      return `card:${target.cardId}`;
    case 'printing':
      return `printing:${target.printingId}`;
    case 'copy':
      return `copy:${target.copyId}`;
    case 'pending':
      return `pending:${target.entryId}`;
  }
}

/** The typed target one entry key names, or null when the key names no entry of this level. */
export function cardListTargetOfKey(key: string): CardListTarget | null {
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  const identity = key.slice(separator + 1);
  switch (key.slice(0, separator)) {
    case 'card':
      return { kind: 'card', cardId: identity };
    case 'printing':
      return { kind: 'printing', printingId: identity };
    case 'copy':
      return { kind: 'copy', copyId: identity };
    case 'pending':
      return { kind: 'pending', entryId: identity };
    default:
      return null;
  }
}

/**
 * Private counts of one presented entry: the account's owned copies of it, the distinct physical
 * locations holding those copies, and the intended quantity one tag associates with it
 * (docs/search.md#request-and-result).
 */
export interface CardListEntryCounts {
  readonly owned: number;
  readonly locations: number;
  readonly intended: number | null;
}

/** Reads the private counts of explicit presented entries through the Search contract. */
export interface CardListCountsAccess {
  /** Counts of the requested entries keyed by entry key; a failed read rejects as one batch. */
  ofBatch(
    targets: readonly CardListTarget[],
    tagId: string | null,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, CardListEntryCounts>>;
}

/** Builds the counts access over the Search contract. */
export function searchCounts(search: CardListCountsRead): CardListCountsAccess {
  if (typeof search?.counts !== 'function') {
    throw new TypeError('The ownership fragment reads private counts through Search.');
  }
  return {
    async ofBatch(targets, tagId, signal) {
      if (targets.length === 0) {
        return new Map();
      }
      const result = await search.counts(
        {
          references: targets.map((target) => referenceOfTarget(target)),
          ...(tagId === null ? {} : { tagId }),
        },
        signal,
      );
      return new Map([...result.counts].map(([key, count]) => [key, readCount(count)] as const));
    },
  };
}

function referenceOfTarget(target: CardListTarget): SearchCountReference {
  switch (target.kind) {
    case 'card':
      return { kind: 'card', cardId: target.cardId };
    case 'printing':
      return { kind: 'printing', printingId: target.printingId };
    case 'copy':
      return { kind: 'copy', copyId: target.copyId };
    case 'pending':
      // Pending import entries are excluded from every ownership count, so Search has no
      // reference for them (docs/user-cards.md#import-and-capture-state).
      throw new TypeError('A pending import entry carries no private count reference.');
  }
}

function readCount(count: SearchCount): CardListEntryCounts {
  return { owned: count.owned, locations: count.locations, intended: count.intended };
}

/**
 * Ownership fragment of a list whose entry keys name card, printing or copy targets directly: the
 * entries' own keys are the references the counts read answers. A failed count read fails the
 * fragment, so an unavailable count is never presented as zero.
 */
export function entryOwnershipReader(
  counts: CardListCountsAccess,
  referenceOfKey: (key: string) => CardListTarget | null = cardListTargetOfKey,
  tagId: () => string | null = () => null,
): CardListFragmentReader<CardListEntryOwnership> {
  return {
    async read(request) {
      const references = new Map<string, CardListTarget>();
      for (const key of request.keys) {
        const target = referenceOfKey(key);
        if (target !== null) {
          references.set(key, target);
        }
      }
      const read = await counts.ofBatch([...references.values()], tagId(), request.signal);
      return request.keys.map((key) => {
        const target = references.get(key) ?? null;
        const count = target === null ? undefined : read.get(cardListEntryKey(target));
        return count === undefined
          ? { key, status: 'absent' as const, values: null }
          : {
              key,
              status: 'ready' as const,
              values: {
                owned: count.owned,
                locations: count.locations,
                intended: count.intended,
              } satisfies CardListEntryOwnership,
            };
      });
    },
  };
}

/** The page one Search contract returned; an answer without entries is not a page. */
function readSearchPage(value: unknown): SearchPage {
  const page = value as SearchPage | null | undefined;
  if (typeof page !== 'object' || page === null || !Array.isArray(page.entries)) {
    throw new TypeError('The Search contract returned no page of entries.');
  }
  return page;
}

/** Failure code of one rejected read, or null when the cause carries none. */
export function readFailureCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) {
    return null;
  }
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * True when a rejected read reported that the revision its continuation named changed: the
 * sequence is invalidated and must restart from its first page rather than repeat the rejected
 * continuation (docs/card-list.md#interface). Provider failure codes are read only here, so a list
 * never interprets a provider's own classification.
 */
export function isInvalidatedContinuation(cause: unknown): boolean {
  const code = readFailureCode(cause);
  return code === 'conflict' || code === 'stale-continuation';
}

export type { CardListEntryImage };
