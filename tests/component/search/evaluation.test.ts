/**
 * Component scope: Search evaluation through its public contract
 * (docs/search.md#required-query-contracts, docs/search.md#freshness). The SQL executor and the
 * account-scope binder are the dependencies outside this component, so these cases substitute
 * them: a public query reads Search's own published relations only, a private query reads inside
 * the bound account, an unusable read is an unavailable evaluation rather than an empty result,
 * and an index that has not caught up is an updating result rather than an empty collection.
 */

import { describe, expect, it } from 'vitest';

import {
  SEARCH_PROJECTION_SURFACE,
  SearchError,
  createSearch,
  type SearchSqlExecutor,
  type SearchSqlRow,
} from '../../../src/search/index.js';

import { callerInput } from './harness.js';

const account = { accountId: 'account-42' };

/** Account-scoped projection relations a public query must never read. */
const privateRelations = [
  SEARCH_PROJECTION_SURFACE.relations.copies.name,
  SEARCH_PROJECTION_SURFACE.relations.tags.name,
  SEARCH_PROJECTION_SURFACE.relations.associations.name,
  SEARCH_PROJECTION_SURFACE.relations.accountState.name,
];

/** One indexed-state row of a page statement, as Search's own projection reports it. */
function stateRow(options: {
  readonly incorporated?: boolean;
  readonly generation?: string | null;
  readonly catalogRevision?: string | null;
  readonly catalogPosition?: string | null;
  readonly privateRevision?: string | null;
  readonly boundAccount?: string | null;
  readonly totalCount?: number | null;
}): SearchSqlRow {
  return {
    row_kind: 'state',
    required_incorporated: options.incorporated ?? true,
    row_position: 0,
    generation: options.generation === undefined ? 'generation-1' : options.generation,
    catalog_revision:
      options.catalogRevision === undefined ? 'revision-1' : options.catalogRevision,
    catalog_position: options.catalogPosition === undefined ? '9' : options.catalogPosition,
    private_revision: options.privateRevision === undefined ? '3' : options.privateRevision,
    bound_account: options.boundAccount === undefined ? null : options.boundAccount,
    total_count: options.totalCount === undefined ? 0 : options.totalCount,
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
  it('reads a public query from Search’s own published relations and no private relation', async () => {
    const statements: string[] = [];
    let scoped = false;
    const search = createSearch({
      sql: {
        async query(statement) {
          statements.push(statement);
          return [stateRow({ privateRevision: null })];
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
    expect(statements[0]).toContain(SEARCH_PROJECTION_SURFACE.relations.cards.name);
    expect(statements[0]).toContain(SEARCH_PROJECTION_SURFACE.relations.indexState.name);
    expect(statements[0]).not.toContain('catalog.');
    expect(statements[0]).not.toContain('usercards');
    for (const relation of privateRelations) {
      expect(statements[0]).not.toContain(relation);
    }
    expect(page.status).toBe('ready');
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.revisions).toEqual({
      generation: 'generation-1',
      catalogRevision: 'revision-1',
      catalogPosition: '9',
      privateRevision: null,
    });
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
          query: async () => [
            stateRow({
              catalogRevision: 'revision-7',
              privateRevision: '3',
              boundAccount: 'account-42',
            }),
          ],
        });
      },
    });

    const page = await search.execute(callerInput({ resultLevel: 'copy' }), account);

    expect(scopes).toEqual(['account-42']);
    expect(page.status).toBe('ready');
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.revisions).toEqual({
      generation: 'generation-1',
      catalogRevision: 'revision-7',
      catalogPosition: '9',
      privateRevision: '3',
    });
  });

  it('reports an unpublished generation as updating without results, never as an empty page', async () => {
    const search = createSearch({
      sql: {
        async query() {
          return [
            stateRow({
              generation: null,
              catalogRevision: null,
              catalogPosition: null,
              privateRevision: null,
              totalCount: null,
            }),
          ];
        },
      },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });

    const page = await search.execute(callerInput({ resultLevel: 'card', query: 'bolt' }), account);

    expect(page.status).toBe('updating');
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBeNull();
    expect(page.continuation).toBeNull();
    expect(page.revisions).toBeNull();
  });

  it('reports an account without indexed private state as updating without results', async () => {
    const search = createSearch({
      sql: {
        async query() {
          return [];
        },
      },
      withAccountScope: async (_accountId, work) =>
        work({
          query: async () => [
            stateRow({ privateRevision: null, totalCount: 0, boundAccount: 'account-42' }),
          ],
        }),
    });

    const page = await search.execute(callerInput({ resultLevel: 'copy' }), account);

    expect(page.status).toBe('updating');
    expect(page.entries).toEqual([]);
    expect(page.totalCount).toBeNull();
    expect(page.revisions?.privateRevision).toBeNull();
  });

  it('reports a required position as updating until the indexed state incorporates it', async () => {
    const search = (privateRevision: string) =>
      createSearch({
        sql: {
          async query() {
            return [];
          },
        },
        withAccountScope: async (_accountId, work) =>
          work({
            query: async () => [
              stateRow({
                privateRevision,
                incorporated: privateRevision === '12',
                totalCount: 0,
                boundAccount: 'account-42',
              }),
            ],
          }),
      });

    const behind = await search('4').execute(
      callerInput({ resultLevel: 'copy', requiredPosition: '9' }),
      account,
    );
    const ahead = await search('12').execute(
      callerInput({ resultLevel: 'copy', requiredPosition: '9' }),
      account,
    );

    expect(behind.status).toBe('updating');
    expect(behind.totalCount).toBe(0);
    expect(behind.revisions?.privateRevision).toBe('4');
    expect(ahead.status).toBe('ready');
  });

  it('reports a required catalog revision as updating until the generation holds it', async () => {
    const search = (catalogRevision: string) =>
      createSearch({
        sql: {
          query: async () => [
            stateRow({
              catalogRevision,
              incorporated: catalogRevision === 'revision-2',
              privateRevision: null,
            }),
          ],
        },
        withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
      });

    const behind = await search('revision-1').execute(
      callerInput({ resultLevel: 'card', requiredCatalogRevision: 'revision-2' }),
    );
    const ahead = await search('revision-2').execute(
      callerInput({ resultLevel: 'card', requiredCatalogRevision: 'revision-2' }),
    );

    expect(behind.status).toBe('updating');
    expect(behind.revisions?.catalogRevision).toBe('revision-1');
    expect(ahead.status).toBe('ready');
  });

  it('requires trusted context for a required publication position', async () => {
    const search = createSearch({
      sql: { query: async () => [] },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });

    const problem = await captureSearchError(() =>
      search.execute(callerInput({ resultLevel: 'card', requiredPosition: '9' })),
    );

    expect(problem.code).toBe('unauthorized');
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

    const missingState = createSearch({
      sql: { query: async () => [] },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });
    const missing = await captureSearchError(() =>
      missingState.execute(callerInput({ resultLevel: 'card' }), account),
    );
    expect(missing.code).toBe('unavailable');
  });

  it('rejects an unreadable continuation before reading anything', async () => {
    let reads = 0;
    const search = createSearch({
      sql: {
        async query() {
          reads += 1;
          return [stateRow({ privateRevision: null })];
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
