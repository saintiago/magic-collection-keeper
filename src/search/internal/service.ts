import type { TrustedUserContext } from '../../usercards/index.js';

import { readTrustedAccountId } from './context.js';
import {
  encodeSearchContinuation,
  readSearchContinuation,
  verifySearchContinuation,
} from './continuation.js';
import { SearchError } from './errors.js';
import { pageStatement, type SearchPageStatement } from './evaluation.js';
import type { SearchSqlExecutor, SearchSqlRow } from './executor.js';
import { requiresTrustedContext, type SearchQuery, type SearchRequestInput } from './model.js';
import { normalizeSearchRequest } from './request.js';
import {
  searchEntryKey,
  type SearchEntry,
  type SearchEntryQuantity,
  type SearchEntryTarget,
  type SearchPage,
} from './results.js';
import { readSearchRows, type SearchEntryRow } from './rows.js';

/**
 * Search evaluation (docs/search.md#required-query-contracts,
 * docs/search.md#evaluation-and-grouping).
 *
 * A request normalizes into one query before anything is read; filters and grouping then run over
 * the complete result inside one database statement, which also reports the exact total count and
 * the revisions, before the requested page boundary is applied. A private query reads the
 * account-scoped views inside the scope Application binds; a public query never touches them. Only
 * a successful evaluation returns a page: an invalid or unsupported request, missing trusted
 * context, a stale continuation and a temporary failure stay distinct failures
 * (docs/search.md#consistency).
 */

export interface Search {
  /** Evaluates one request into the page of the complete result it names. */
  execute(request: SearchRequestInput, context?: TrustedUserContext | null): Promise<SearchPage>;
}

export interface SearchDependencies {
  /**
   * Read-only executor over the published Catalog and UserCards relations, supplied by
   * Application. Public queries read it directly; statements use `:name` placeholders.
   */
  readonly sql: SearchSqlExecutor;
  /**
   * Runs `work` with the trusted account bound to UserCards' published views for one read
   * transaction, so a private query sees one account's rows and one coherent private revision.
   * Application binds the authenticated scope here rather than Search handling account state.
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
      if (cursor !== null) {
        verifySearchContinuation(cursor, {
          query,
          context,
          revisions: page.revisions,
        });
      }
      const hasMore = page.entries.length > query.pageSize;
      const entries = hasMore ? page.entries.slice(0, query.pageSize) : page.entries;
      return {
        entries: entries.map((entry) => searchEntry(entry, query)),
        totalCount: page.totalCount,
        continuation: hasMore
          ? encodeSearchContinuation({
              query,
              context,
              revisions: page.revisions,
              offset: offset + query.pageSize,
            })
          : null,
        revisions: page.revisions,
      };
    },
  };
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
