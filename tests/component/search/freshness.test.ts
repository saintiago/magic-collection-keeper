/**
 * Component scope: the bounded freshness observation through Search's public contract
 * (docs/search.md#freshness). The SQL executor is the dependency outside the component, so these
 * cases substitute it and control the indexed state each round reports: a required position is
 * incorporated when the published generation reaches it, a bound that expires reports delayed, a
 * withdrawn observation reports unavailable and a missing generation is never incorporated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SEARCH_LIMITS,
  createSearch,
  type Search,
  type SearchSqlRow,
} from '../../../src/search/index.js';

const account = { accountId: 'account-42' };

/** One indexed-state row of a progress read. */
function progressRow(options: {
  readonly generation?: string | null;
  readonly catalogRevision?: string | null;
  readonly privateRevision?: string | null;
}): SearchSqlRow {
  return {
    row_kind: 'state',
    generation: options.generation === undefined ? 'generation-1' : options.generation,
    catalog_revision:
      options.catalogRevision === undefined ? 'revision-1' : options.catalogRevision,
    catalog_position: options.generation === null ? null : '9',
    private_revision: options.privateRevision === undefined ? '12' : options.privateRevision,
  };
}

/** Search whose account-scoped read answers with the rows a case scripts. */
function searchOver(rows: () => readonly SearchSqlRow[]): Search {
  return createSearch({
    sql: { query: async () => rows() },
    withAccountScope: async (_accountId, work) => work({ query: async () => rows() }),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('search freshness observation', () => {
  it('reports the indexed positions even when no minimum was requested', async () => {
    const state = await searchOver(() => [progressRow({})]).observe({}, account);

    expect(state.state).toBe('incorporated');
    expect(state.revisions).toEqual({
      generation: 'generation-1',
      catalogRevision: 'revision-1',
      catalogPosition: '9',
      privateRevision: '12',
    });
  });

  it('reports indexing for a zero bound and delayed when the bound expires', async () => {
    vi.useFakeTimers();
    const indexed = searchOver(() => [progressRow({ privateRevision: '4' })]);

    const now = await indexed.observe({ positions: ['9'] }, account);
    const delayed = indexed.observe({ positions: ['9'] }, account, {
      timeoutMs: SEARCH_LIMITS.observationIntervalMs,
    });
    await vi.advanceTimersByTimeAsync(SEARCH_LIMITS.observationIntervalMs);

    expect(now.state).toBe('indexing');
    expect(now.revisions?.privateRevision).toBe('4');
    const expired = await delayed;
    expect(expired.state).toBe('delayed');
    expect(expired.revisions?.privateRevision).toBe('4');
  });

  it('reports incorporation as soon as a bounded wait observes the required position', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const search = searchOver(() => {
      reads += 1;
      return [progressRow({ privateRevision: reads === 1 ? '4' : '9' })];
    });

    const pending = search.observe({ positions: ['9'] }, account, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(SEARCH_LIMITS.observationIntervalMs);
    const incorporated = await pending;

    expect(incorporated.state).toBe('incorporated');
    expect(incorporated.revisions?.privateRevision).toBe('9');
  });

  it('never reports a missing generation or account position as incorporated', async () => {
    vi.useFakeTimers();
    const unpublished = searchOver(() => [
      progressRow({ generation: null, catalogRevision: null, privateRevision: null }),
    ]);
    const unindexed = searchOver(() => [progressRow({ privateRevision: null })]);

    const pending = unpublished.observe({ catalogRevision: 'revision-1' }, account, {
      timeoutMs: SEARCH_LIMITS.observationIntervalMs,
    });
    const pendingPrivate = unindexed.observe({ positions: ['9'] }, account, {
      timeoutMs: SEARCH_LIMITS.observationIntervalMs,
    });
    await vi.advanceTimersByTimeAsync(SEARCH_LIMITS.observationIntervalMs);

    expect((await pending).state).toBe('delayed');
    expect((await pendingPrivate).state).toBe('delayed');
  });

  it('reports a different catalog revision as not incorporated', async () => {
    const search = searchOver(() => [progressRow({ catalogRevision: 'revision-7' })]);

    const observation = await search.observe({ catalogRevision: 'revision-1' }, account);
    const incorporated = await search.observe({ catalogRevision: 'revision-7' }, account);

    expect(observation.state).toBe('indexing');
    expect(incorporated.state).toBe('incorporated');
  });

  it('requires trusted context for a required publication position', async () => {
    const search = searchOver(() => [progressRow({})]);

    await expect(search.observe({ positions: ['9'] })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(search.observe({ catalogRevision: 'revision-1' })).resolves.toMatchObject({
      state: 'incorporated',
    });
  });

  it('fails a withdrawn observation instead of reporting completion', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const search = searchOver(() => [progressRow({ privateRevision: '4' })]);

    const pending = search.observe({ positions: ['9'] }, account, {
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await rejected;
  });

  it('rejects an observation bound outside the declared limit', async () => {
    const search = searchOver(() => [progressRow({})]);

    await expect(
      search.observe({}, account, { timeoutMs: SEARCH_LIMITS.maxObservationTimeoutMs + 1 }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('fails an unusable read instead of reporting progress', async () => {
    const search = createSearch({
      sql: {
        async query() {
          throw new Error('the database is unreachable');
        },
      },
      withAccountScope: async (_accountId, work) => work({ query: async () => [] }),
    });

    await expect(search.observe({ positions: ['9'] }, account)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
