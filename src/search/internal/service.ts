import type { TrustedUserContext } from '../../usercards/index.js';

import { readTrustedAccountId } from './context.js';
import {
  encodeSearchContinuation,
  readSearchContinuation,
  verifySearchContinuation,
} from './continuation.js';
import { SearchError } from './errors.js';
import { countsStatement, pageStatement, type SearchPageStatement } from './evaluation.js';
import type { SearchSqlExecutor, SearchSqlRow } from './executor.js';
import {
  type IndexedProgress,
  progressStatement,
  readSearchProgressRows,
  type SearchObservationOptions,
  type SearchProgress,
  type SearchProgressRequest,
} from './freshness.js';
import {
  SEARCH_LIMITS,
  requiresTrustedContext,
  type SearchQuery,
  type SearchRequiredProgress,
  type SearchRequestInput,
  type SearchRevisions,
} from './model.js';
import {
  normalizeSearchCountRequest,
  normalizeSearchProgressRequest,
  normalizeSearchRequest,
} from './request.js';
import {
  searchEntryKey,
  type SearchEntry,
  type SearchEntryQuantity,
  type SearchEntryTarget,
  type SearchCountInput,
  type SearchCountResult,
  type SearchPage,
} from './results.js';
import { readSearchCountRows, readSearchRows, type SearchEntryRow } from './rows.js';

/**
 * Search evaluation and freshness over Search's own projection
 * (docs/search.md#required-query-contracts, docs/search.md#evaluation-and-grouping,
 * docs/search.md#freshness).
 *
 * A request normalizes into one query before anything is read; filters and grouping then run over
 * the complete result inside one database statement, which also reports the exact total count and
 * the indexed state, before the requested page boundary is applied. A private query reads the
 * account-scoped projection views inside the scope Application binds; a public query never touches
 * them. Only a successful evaluation returns a result: an invalid or unsupported request, missing
 * trusted context, a stale continuation and a temporary failure stay distinct failures
 * (docs/search.md#consistency). A result that has not incorporated a required publication position
 * is reported as updating — with the last usable indexed result when the published generation
 * answers the query, and without one when it does not — never as an empty collection or a failure
 * (docs/search.md#freshness).
 */

export interface Search {
  /** Evaluates one request into the page of the complete result it names. */
  execute(request: SearchRequestInput, context?: TrustedUserContext | null): Promise<SearchPage>;
  /**
   * Reads the account's private counts of explicit references: owned copies, the distinct physical
   * locations holding them and one tag's intended quantity covering each reference. The read
   * enriches presented entries without changing any query's membership.
   */
  counts(
    request: SearchCountInput,
    context?: TrustedUserContext | null,
  ): Promise<SearchCountResult>;
  /**
   * Reports whether the authenticated account's indexed state incorporates known committed
   * publication positions and an optional published catalog revision, waiting at most the
   * requested bound. The observation creates no indexing work and never claims the index holds
   * every current source write (docs/search.md#freshness).
   */
  observe(
    request: SearchProgressRequest,
    context?: TrustedUserContext | null,
    options?: SearchObservationOptions,
  ): Promise<SearchProgress>;
}

export interface SearchDependencies {
  /**
   * Read-only executor over Search's published projection, supplied by Application. Public reads
   * use it directly; statements use `:name` placeholders.
   */
  readonly sql: SearchSqlExecutor;
  /**
   * Runs `work` with the trusted account bound to Search's account-scoped projection views for one
   * read transaction, so a private query sees one account's rows and one coherent indexed
   * position. Application binds the authenticated scope here rather than Search handling account
   * state.
   */
  readonly withAccountScope: <T>(
    accountId: string,
    work: (sql: SearchSqlExecutor) => Promise<T>,
  ) => Promise<T>;
}

export function createSearch(dependencies: SearchDependencies): Search {
  const sql = dependencies?.sql;
  if (sql === undefined || typeof sql.query !== 'function') {
    throw new TypeError('createSearch requires a SQL executor with a query method.');
  }
  const withAccountScope = dependencies?.withAccountScope;
  if (typeof withAccountScope !== 'function') {
    throw new TypeError(
      'createSearch requires a binder for the trusted account’s private query surface.',
    );
  }

  /**
   * Reads one page. A private query reads inside the bound account scope, so an unusable scope
   * fails as an unavailable evaluation instead of silently returning nothing.
   */
  async function readPage(
    query: SearchQuery,
    context: TrustedUserContext | null,
    request: SearchPageStatement,
  ): Promise<readonly SearchSqlRow[]> {
    if (!requiresTrustedContext(query)) {
      return readRows(request, sql);
    }
    const accountId = readTrustedAccountId(context);
    if (accountId === null) {
      throw new SearchError(
        'unauthorized',
        'Private search criteria and physical-copy results require authenticated context.',
      );
    }
    try {
      return await withAccountScope(accountId, (scoped) => readRows(request, scoped));
    } catch (cause) {
      throw evaluationFailure(cause);
    }
  }

  /** Reads the indexed state of one account; without a usable account it stays public. */
  async function readIndexedState(
    accountId: string | null,
    required: SearchRequiredProgress,
  ): Promise<IndexedProgress> {
    if (accountId === null) {
      return readState(sql, required);
    }
    try {
      return await withAccountScope(accountId, (scoped) => readState(scoped, required));
    } catch (cause) {
      throw evaluationFailure(cause);
    }
  }

  return {
    async execute(
      request: SearchRequestInput,
      context: TrustedUserContext | null = null,
    ): Promise<SearchPage> {
      const query = normalizeSearchRequest(request, context);
      const cursor =
        typeof request?.continuation === 'string'
          ? readSearchContinuation(request.continuation)
          : null;
      const offset = cursor?.offset ?? 0;
      const rows = await readPage(query, context, pageStatement(query, offset, query.pageSize + 1));
      const page = readSearchRows(rows, query);
      const revisions = page.revisions;
      const usable =
        revisions !== null &&
        (!requiresTrustedContext(query) || revisions.privateRevision !== null);
      if (revisions === null || !usable) {
        if (cursor !== null) {
          throw new SearchError(
            'stale-continuation',
            'The indexed search results are not available yet; start the search again.',
          );
        }
        return {
          status: 'updating',
          entries: [],
          totalCount: null,
          continuation: null,
          revisions,
        };
      }
      if (cursor !== null) {
        verifySearchContinuation(cursor, {
          query,
          context,
          revisions,
        });
      }
      const hasMore = page.entries.length > query.pageSize;
      const entries = hasMore ? page.entries.slice(0, query.pageSize) : page.entries;
      return {
        status: page.incorporated ? 'ready' : 'updating',
        entries: entries.map((entry) => searchEntry(entry, query)),
        totalCount: page.totalCount,
        continuation: hasMore
          ? encodeSearchContinuation({
              query,
              context,
              revisions,
              offset: offset + query.pageSize,
            })
          : null,
        revisions,
      };
    },

    /**
     * Reads one private count query. A count read always describes the account's private records,
     * so it needs usable trusted context and reads inside the account scope; a reference the
     * evaluation cannot count fails the read instead of reporting an inferred zero.
     */
    async counts(
      request: SearchCountInput,
      context: TrustedUserContext | null = null,
    ): Promise<SearchCountResult> {
      const query = normalizeSearchCountRequest(request);
      const accountId = readTrustedAccountId(context);
      if (accountId === null) {
        throw new SearchError('unauthorized', 'Private counts require authenticated context.');
      }
      const statement = countsStatement(query.references, query.tagId);
      let rows: readonly SearchSqlRow[];
      try {
        rows = await withAccountScope(accountId, (scoped) => readRows(statement, scoped));
      } catch (cause) {
        throw evaluationFailure(cause);
      }
      return readSearchCountRows(rows, query.references);
    },

    /**
     * Observes one bounded wait for incorporation. Each round reads the indexed state again, so a
     * wait that expires reports delayed while a wait that sees the required progress reports
     * incorporated; the bound covers the whole wait, including the time a read spends answering,
     * so a stalled storage read cannot keep it open past its deadline. The read never starts
     * indexing work, an unusable read fails as unavailable rather than reporting completion, and a
     * withdrawn observation fails as unavailable instead of completing after the withdrawal
     * (docs/search.md#freshness).
     */
    async observe(
      request: SearchProgressRequest,
      context: TrustedUserContext | null = null,
      options: SearchObservationOptions = {},
    ): Promise<SearchProgress> {
      const required = normalizeSearchProgressRequest(request);
      const accountId = readTrustedAccountId(context);
      if (required.positions.length > 0 && accountId === null) {
        throw new SearchError(
          'unauthorized',
          'Requiring a private publication position needs authenticated context.',
        );
      }
      const timeoutMs = readObservationTimeout(options?.timeoutMs);
      const signal = options?.signal ?? null;
      // The bound is a deadline over the whole observation rather than a sum of its sleeps: time
      // spent inside a read counts against it, so a stalled read reports delayed instead of
      // leaving the wait pending indefinitely (docs/search.md#freshness).
      const deadline = timeoutMs === 0 ? null : Date.now() + timeoutMs;
      /** The indexed state the observation read last; null while no read has answered yet. */
      let revisions: SearchRevisions | null = null;
      for (;;) {
        requireNotCancelled(signal);
        const read = await readWithinDeadline(
          () => readIndexedState(accountId, required),
          deadline,
          signal,
        );
        // A withdrawal that happened while the read was outstanding wins over its result.
        requireNotCancelled(signal);
        if (read === observationExpired) {
          return { state: 'delayed', revisions };
        }
        revisions = read.revisions;
        if (read.incorporated) {
          return { state: 'incorporated', revisions };
        }
        if (deadline === null) {
          return { state: 'indexing', revisions };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { state: 'delayed', revisions };
        }
        await waitForInterval(Math.min(SEARCH_LIMITS.observationIntervalMs, remaining), signal);
      }
    },
  };
}

/** Reads the one indexed-state row of a progress statement. */
async function readState(
  sql: SearchSqlExecutor,
  required: SearchRequiredProgress,
): Promise<IndexedProgress> {
  try {
    const request = progressStatement(required);
    return readSearchProgressRows(await sql.query(request.statement, request.parameters));
  } catch (cause) {
    throw evaluationFailure(cause);
  }
}

/** The observation bound a caller requested; unbounded waits are not part of the contract. */
function readObservationTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return 0;
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > SEARCH_LIMITS.maxObservationTimeoutMs
  ) {
    throw new SearchError(
      'invalid-request',
      `An observation waits 0 to ${SEARCH_LIMITS.maxObservationTimeoutMs} whole milliseconds.`,
    );
  }
  return timeoutMs;
}

/** The bound of one observation expired while its indexed-state read was still outstanding. */
const observationExpired = Symbol('search-observation-expired');

/** One read of the observation's indexed state, or the report that its bound expired first. */
type ObservationRead = IndexedProgress | typeof observationExpired;

/**
 * Awaits one indexed-state read inside the observation's bound. The remaining wait and the
 * caller's withdrawal are enforced while the read is outstanding, so a stalled read cannot keep
 * the observation pending past its deadline and a cancelled observation does not wait for a read
 * it already withdrew; a read that answers later is no longer awaited and its outcome never
 * reaches the caller (docs/search.md#freshness).
 */
function readWithinDeadline(
  read: () => Promise<IndexedProgress>,
  deadline: number | null,
  signal: AbortSignal | null,
): Promise<ObservationRead> {
  if (deadline === null && signal === null) {
    return read();
  }
  return new Promise<ObservationRead>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort(): void {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      reject(cancelled());
    }
    function onDeadline(): void {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      resolve(observationExpired);
    }
    if (signal?.aborted === true) {
      reject(cancelled());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (deadline !== null) {
      timer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()));
    }
    read().then(
      (revisions) => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        resolve(revisions);
      },
      (cause: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        reject(cause);
      },
    );
  });
}

/** Fails a withdrawn observation as unavailable: cancellation never reports completion. */
function requireNotCancelled(signal: AbortSignal | null): void {
  if (signal?.aborted === true) {
    throw cancelled();
  }
}

/**
 * Waits one observation interval. Cancelling the observation stops the wait instead of leaving it
 * pending, and a withdrawn wait fails as unavailable: it never reports that progress completed.
 */
function waitForInterval(delayMs: number, signal: AbortSignal | null): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(cancelled());
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (outcome: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cancelled(): SearchError {
  return new SearchError('unavailable', 'The indexing observation was cancelled.');
}

async function readRows(
  request: SearchPageStatement,
  sql: SearchSqlExecutor,
): Promise<readonly SearchSqlRow[]> {
  try {
    return await sql.query(request.statement, request.parameters);
  } catch (cause) {
    throw evaluationFailure(cause);
  }
}

function searchEntry(entry: SearchEntryRow, query: SearchQuery): SearchEntry {
  const target: SearchEntryTarget =
    query.resultLevel === 'card'
      ? { kind: 'card', cardId: entry.entryId }
      : query.resultLevel === 'printing'
        ? { kind: 'printing', printingId: entry.entryId }
        : { kind: 'copy', copyId: entry.entryId };
  const quantity: SearchEntryQuantity | null =
    entry.copies === null && entry.intended === null
      ? null
      : { copies: entry.copies, intended: entry.intended };
  return {
    entryKey: searchEntryKey(target),
    target,
    card: { cardId: entry.cardId, name: entry.cardName, matchedName: entry.matchedName },
    printing: entry.printing,
    quantity,
  };
}

function evaluationFailure(cause: unknown): SearchError {
  return cause instanceof SearchError
    ? cause
    : new SearchError('unavailable', 'The search could not be evaluated.', { cause });
}
