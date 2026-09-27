/**
 * Component scope: Search evaluation through its public contract
 * (docs/search.md#required-query-contracts). The SQL executor and the account-scope binder are the
 * dependencies outside this component, so these cases substitute them: a public query never
 * touches the private query surface, a private query reads inside the bound account, and an
 * unusable read is an unavailable evaluation rather than an empty page.
 */

import { describe, expect, it } from 'vitest';

import {
  SearchError,
  createSearch,
  type SearchSqlExecutor,
  type SearchSqlRow,
} from '../../../src/search/index.js';
import { USERCARDS_QUERY_SURFACE } from '../../../src/usercards/index.js';

import { callerInput } from './harness.js';

const account = { accountId: 'account-42' };

const privateRelations = Object.values(USERCARDS_QUERY_SURFACE.relations).map(
  (relation) => relation.name,
);

function revisionRow(
  catalogRevision: string,
  privateRevision: string | null,
  totalCount: number,
): SearchSqlRow {
  return {
    row_kind: 'revision',
    row_position: 0,
    catalog_revision: catalogRevision,
    private_revision: privateRevision,
    total_count: totalCount,
  };
}

async function captureSearchError(run: () => Promise<unknown>): Promise<SearchError> {
  const outcome = await run().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(outcome instanceof SearchError)) {
    throw new Error(`Expected a SearchError, received ${String(outcome)}.`);
  }
  return outcome;
}

describe('search evaluation contract', () => {
  it('keeps a public query out of the private query surface and account scope', async () => {
    const statements: string[] = [];
    let scoped = false;
    const search = createSearch({
      sql: {
        async query(statement) {
          statements.push(statement);
          return [revisionRow('revision-1', null, 0)];
        },
      },
      withAccountScope: async (_accountId, work) => {
        scoped = true;
        return work({ query: async () => [] });
      },
    });

    const page = await search.execute(callerInput({ resultLevel: 'card', query: 'bolt' }), account);

    expect(scoped).toBe(false);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('catalog.cards');
    for (const relation of privateRelations) {
      expect(statements[0]).not.toContain(relation);
    }
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.revisions).toEqual({ catalogRevision: 'revision-1', privateRevision: null });
  });

  it('reads a private query only inside the bound account scope', async () => {
    const scopes: string[] = [];
    const search = createSearch({
      sql: {
        async query() {
          throw new Error('a private query reached the unscoped executor');
        },
      },
      withAccountScope: async (accountId, work) => {
        scopes.push(accountId);
        return work({
          query: async () => [revisionRow('revision-7', '3', 0)],
        });
      },
    });

    const page = await search.execute(callerInput({ resultLevel: 'copy' }), account);

    expect(scopes).toEqual(['account-42']);
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.revisions).toEqual({ catalogRevision: 'revision-7', privateRevision: '3' });
  });

  it('reports an unusable read as unavailable instead of an empty page', async () => {
    const failure: SearchSqlExecutor = {
      async query() {
        throw new Error('the database is unreachable');
      },
    };
    const search = createSearch({
      sql: failure,
      withAccountScope: async (_accountId, work) => work(failure),
    });

    const problem = await captureSearchError(() =>
      search.execute(callerInput({ resultLevel: 'card', query: 'bolt' })),
    );
    const privateFailure = await captureSearchError(() =>
      search.execute(callerInput({ resultLevel: 'copy' }), account),
    );

    expect(problem.code).toBe('unavailable');
    expect(privateFailure.code).toBe('unavailable');
  });

  it('reports a readable but inconsistent result as unavailable', async () => {
    const search = createSearch({
      sql: {
        async query() {
          return [{ row_kind: 'entry', row_position: 1 }];
        },
      },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });

    const incomplete = await captureSearchError(() =>
      search.execute(callerInput({ resultLevel: 'card', query: 'bolt' })),
    );
    expect(incomplete.code).toBe('unavailable');

    const unscopedPrivate = createSearch({
      sql: {
        async query() {
          return [revisionRow('revision-1', null, 0)];
        },
      },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });
    const missingRevision = await captureSearchError(() =>
      unscopedPrivate.execute(callerInput({ resultLevel: 'copy' }), account),
    );
    expect(missingRevision.code).toBe('unavailable');
  });

  it('rejects an unreadable continuation before reading anything', async () => {
    let reads = 0;
    const search = createSearch({
      sql: {
        async query() {
          reads += 1;
          return [revisionRow('revision-1', null, 0)];
        },
      },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });

    const problem = await captureSearchError(() =>
      search.execute(callerInput({ resultLevel: 'card', continuation: 'not a continuation' })),
    );

    expect(problem.code).toBe('invalid-request');
    expect(reads).toBe(0);
  });
});
