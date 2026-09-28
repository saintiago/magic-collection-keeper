/**
 * Component scope: the search request and result contract
 * (docs/search.md#request-and-result). Requests normalize into one bounded query, the account
 * comes from trusted context instead of a field, private criteria require authenticated context,
 * and a continuation is bound to the normalized criteria, the ordering, the user and the
 * revisions. Evaluation against the published relations belongs to the search evaluation task.
 */

import { describe, expect, it } from 'vitest';

import {
  SEARCH_LIMITS,
  decodeSearchContinuation,
  encodeSearchContinuation,
  normalizeSearchRequest,
  searchEntryKey,
  type SearchContinuationBinding,
  type SearchFilter,
  type SearchPage,
  type SearchQuery,
  type SearchRevisions,
} from '../../../src/search/index.js';

import { callerInput, captureSearchError } from './harness.js';

const account = { accountId: 'account-42' };

function privateQuery(): SearchQuery {
  return normalizeSearchRequest(
    callerInput({ resultLevel: 'card', criteria: [{ kind: 'owned' }] }),
    account,
  );
}

function bindingFor(query: SearchQuery) {
  return {
    query,
    context: account,
    revisions: indexedState(),
  };
}

/** One indexed state a page or continuation was bound to. */
function indexedState(overrides: Partial<SearchRevisions> = {}): SearchRevisions {
  return {
    generation: 'generation-1',
    catalogRevision: 'catalog-7',
    catalogPosition: '9',
    privateRevision: '12',
    ...overrides,
  };
}

describe('search requests', () => {
  it('defaults the ordering and page size of a request without criteria', () => {
    const query = normalizeSearchRequest(callerInput({ resultLevel: 'card' }));

    expect(query).toEqual({
      resultLevel: 'card',
      filters: [],
      ordering: { field: 'name', direction: 'ascending' },
      pageSize: SEARCH_LIMITS.defaultPageSize,
      required: { positions: [], catalogRevision: null },
    });
  });

  it('accepts a requested ordering and page size', () => {
    const query = normalizeSearchRequest(
      callerInput({
        resultLevel: 'printing',
        ordering: { field: 'manaValue', direction: 'descending' },
        pageSize: 25,
      }),
    );

    expect(query.ordering).toEqual({ field: 'manaValue', direction: 'descending' });
    expect(query.pageSize).toBe(25);
  });

  it('rejects a request outside the request contract', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [{ resultLevel: 'cards' }, 'result level'],
      [{ resultLevel: 'card', pageSize: 0 }, 'page size'],
      [{ resultLevel: 'card', pageSize: SEARCH_LIMITS.maxPageSize + 1 }, 'page size'],
      [{ resultLevel: 'card', pageSize: 2.5 }, 'page size'],
      [{ resultLevel: 'card', ordering: { field: 'edition', direction: 'ascending' } }, 'ordering'],
      [{ resultLevel: 'card', ordering: { field: 'name', direction: 'up' } }, 'ordering'],
      [
        {
          resultLevel: 'card',
          criteria: Array.from({ length: SEARCH_LIMITS.maxCriteria + 1 }, () => ({
            kind: 'owned',
          })),
        },
        'criteria',
      ],
      [{ resultLevel: 'card', query: 'x'.repeat(SEARCH_LIMITS.maxQueryLength + 1) }, 'expression'],
    ];

    for (const [request, message] of cases) {
      const error = captureSearchError(() => normalizeSearchRequest(callerInput(request), account));

      expect(error.code).toBe('invalid-request');
      expect(error.message).toContain(message);
    }
  });

  it('rejects structured criteria outside the supported vocabulary', () => {
    const cases: readonly unknown[] = [
      { kind: 'finish', finish: 'glossy' },
      { kind: 'color', comparison: '>=', colors: ['X'] },
      { kind: 'color', comparison: ':', colors: ['U'] },
      { kind: 'color', comparison: '>=', colors: [] },
      { kind: 'manaValue', comparison: '>=', value: -1 },
      { kind: 'manaValue', comparison: '>=', value: '3' },
      { kind: 'language', language: 'japanese' },
      { kind: 'set', edition: 'not a code' },
      { kind: 'name', text: '' },
      { kind: 'tag', tagId: '' },
      { kind: 'deck', tagId: 'deck-1' },
    ];

    for (const criterion of cases) {
      const error = captureSearchError(() =>
        normalizeSearchRequest(
          callerInput({ resultLevel: 'card', criteria: [criterion] }),
          account,
        ),
      );

      expect(error.code).toBe('invalid-request');
    }
  });

  it('reports an unsupported text expression through the request too', () => {
    const error = captureSearchError(() =>
      normalizeSearchRequest(callerInput({ resultLevel: 'card', query: 'is:commander' }), account),
    );

    expect(error.code).toBe('unsupported-query');
    expect(error.message).toContain('is:commander');
  });

  it('requires authenticated context for private criteria and copy-level results', () => {
    const requests: readonly unknown[] = [
      { resultLevel: 'card', criteria: [{ kind: 'owned' }] },
      { resultLevel: 'card', criteria: [{ kind: 'tag', tagId: 'deck-1' }] },
      { resultLevel: 'copy' },
      { resultLevel: 'copy', criteria: [{ kind: 'owned' }] },
    ];

    for (const request of requests) {
      expect(captureSearchError(() => normalizeSearchRequest(callerInput(request))).code).toBe(
        'unauthorized',
      );
      expect(
        captureSearchError(() =>
          normalizeSearchRequest(callerInput(request), callerInput({ accountId: '' })),
        ).code,
      ).toBe('unauthorized');
    }
  });

  it('does not let a supplied account field reach a private query', () => {
    const query = normalizeSearchRequest(
      callerInput({
        resultLevel: 'card',
        query: 'c:u',
        criteria: [{ kind: 'owned' }],
        accountId: 'account-99',
      }),
      account,
    );

    expect(query.filters).toEqual([
      { kind: 'criterion', criterion: { kind: 'color', comparison: '>=', colors: ['U'] } },
      { kind: 'criterion', criterion: { kind: 'owned' } },
    ]);
    expect(JSON.stringify(query)).not.toContain('account-99');
    expect(JSON.stringify(query)).not.toContain('account-42');
  });

  it('keeps a public query independent of unused context', () => {
    const query = normalizeSearchRequest(
      callerInput({ resultLevel: 'printing', query: 'set:znr' }),
      callerInput({ accountId: '' }),
    );

    expect(query.filters).toEqual([
      { kind: 'criterion', criterion: { kind: 'set', edition: 'ZNR' } },
    ]);
  });

  it('normalizes the private criteria of the collection views', () => {
    const query = normalizeSearchRequest(
      callerInput({
        resultLevel: 'printing',
        criteria: [{ kind: 'tag', tagId: 'deck-7' }],
        ordering: { field: 'manaValue', direction: 'descending' },
        pageSize: 25,
      }),
      account,
    );

    expect(query).toEqual({
      resultLevel: 'printing',
      filters: [{ kind: 'criterion', criterion: { kind: 'tag', tagId: 'deck-7' } }],
      ordering: { field: 'manaValue', direction: 'descending' },
      pageSize: 25,
      required: { positions: [], catalogRevision: null },
    });
  });

  it('keeps both groups of a conjunction whose values contain a delimiter', () => {
    const query = normalizeSearchRequest(
      callerInput({
        resultLevel: 'card',
        query: '(name:"a;name:b" or c) (a or name:"b;name:c")',
      }),
    );

    expect(query.filters).toHaveLength(2);
    expect(query.filters).toContainEqual({
      kind: 'or',
      operands: [
        { kind: 'criterion', criterion: { kind: 'name', text: 'a;name:b' } },
        { kind: 'criterion', criterion: { kind: 'name', text: 'c' } },
      ],
    });
    expect(query.filters).toContainEqual({
      kind: 'or',
      operands: [
        { kind: 'criterion', criterion: { kind: 'name', text: 'a' } },
        { kind: 'criterion', criterion: { kind: 'name', text: 'b;name:c' } },
      ],
    });
  });
});

describe('search continuations', () => {
  it.each([28, 248])('preserves and resumes a query with %i nested negations', (depth) => {
    const expression = `${'- '.repeat(depth)}bolt`;
    expect(expression.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxQueryLength);
    const query = normalizeSearchRequest({ resultLevel: 'card', query: expression });
    let expected: SearchFilter = {
      kind: 'criterion',
      criterion: { kind: 'name', text: 'bolt' },
    };
    for (let level = 0; level < depth; level += 1) {
      expected = { kind: 'not', operand: expected };
    }
    expect(query.filters).toEqual([expected]);

    const binding = bindingFor(query);
    const token = encodeSearchContinuation({ ...binding, offset: 50 });
    expect(decodeSearchContinuation(token, binding)).toBe(50);
    const changed = normalizeSearchRequest({
      resultLevel: 'card',
      query: `${'- '.repeat(depth - 1)}bolt`,
    });
    expect(
      captureSearchError(() => decodeSearchContinuation(token, { ...binding, query: changed }))
        .code,
    ).toBe('stale-continuation');
  });

  it.each([26, 40])(
    'preserves ordering and continuation binding through %i alternating Boolean groups',
    (depth) => {
      let expression = 'bolt';
      let reordered = 'BOLT';
      let changed = 'elf';
      for (let level = 0; level < depth; level += 1) {
        const operator = level % 2 === 0 ? ' ' : ' or ';
        expression = `(${expression}${operator}name:x)`;
        reordered = `(name:x${operator}${reordered})`;
        changed = `(${changed}${operator}name:x)`;
      }
      expect(expression.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxQueryLength);
      const query = normalizeSearchRequest({ resultLevel: 'card', query: expression });
      const equivalent = normalizeSearchRequest({ resultLevel: 'card', query: reordered });
      expect(query.filters).toEqual(equivalent.filters);
      // Every alternating group must survive normalization, including the innermost leaf.
      let filter = query.filters[0];
      for (let level = depth - 1; level >= 0; level -= 1) {
        expect(filter?.kind).toBe(level % 2 === 0 ? 'and' : 'or');
        if (filter?.kind !== 'and' && filter?.kind !== 'or') {
          throw new Error('Expected a Boolean group');
        }
        expect(filter.operands).toHaveLength(2);
        expect(filter.operands).toContainEqual({
          kind: 'criterion',
          criterion: { kind: 'name', text: 'x' },
        });
        filter = filter.operands.find(
          (operand) =>
            operand.kind !== 'criterion' ||
            operand.criterion.kind !== 'name' ||
            operand.criterion.text !== 'x',
        );
      }
      expect(filter).toEqual({ kind: 'criterion', criterion: { kind: 'name', text: 'bolt' } });

      const binding = bindingFor(query);
      const token = encodeSearchContinuation({ ...binding, offset: 50 });
      expect(decodeSearchContinuation(token, { ...binding, query: equivalent })).toBe(50);
      const different = normalizeSearchRequest({ resultLevel: 'card', query: changed });
      expect(
        captureSearchError(() => decodeSearchContinuation(token, { ...binding, query: different }))
          .code,
      ).toBe('stale-continuation');
    },
  );

  it('resumes the next page of the same query, user and revisions', () => {
    const binding = bindingFor(privateQuery());
    const token = encodeSearchContinuation({ ...binding, offset: 50 });

    expect(typeof token).toBe('string');
    expect(token.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxContinuationLength);
    expect(decodeSearchContinuation(token, binding)).toBe(50);
  });

  it('binds the normalized criteria rather than their spelling or order', () => {
    const query = normalizeSearchRequest(
      callerInput({
        resultLevel: 'printing',
        criteria: [
          { kind: 'color', comparison: '>=', colors: ['W', 'U'] },
          { kind: 'type', text: 'elf' },
        ],
      }),
    );
    const equivalent = normalizeSearchRequest(
      callerInput({ resultLevel: 'printing', query: 't:ELF c:WU' }),
    );
    const binding = {
      query,
      revisions: indexedState({ privateRevision: null }),
    };

    const token = encodeSearchContinuation({ ...binding, offset: 20 });

    expect(decodeSearchContinuation(token, { ...binding, query: equivalent })).toBe(20);
  });

  it('does not let lookalike criteria resume another result sequence', () => {
    const revisions = indexedState({ privateRevision: null });
    const left = normalizeSearchRequest(
      callerInput({ resultLevel: 'card', query: 'name:"a;name:b" or c' }),
    );
    const right = normalizeSearchRequest(
      callerInput({ resultLevel: 'card', query: 'a or name:"b;name:c"' }),
    );
    const token = encodeSearchContinuation({ query: left, revisions, offset: 50 });

    expect(left.filters).not.toEqual(right.filters);
    expect(
      captureSearchError(() => decodeSearchContinuation(token, { query: right, revisions })).code,
    ).toBe('stale-continuation');
  });

  it('treats changed criteria, ordering, user or revisions as stale', () => {
    const binding = bindingFor(privateQuery());
    const token = encodeSearchContinuation({ ...binding, offset: 50 });
    const otherQuery = normalizeSearchRequest(
      callerInput({ resultLevel: 'card', query: 't:elf' }),
      account,
    );
    const otherUser = { accountId: 'account-99' };
    const otherOrdering: SearchQuery = {
      ...binding.query,
      ordering: { field: 'manaValue', direction: 'ascending' },
    };

    const staleCases: readonly SearchContinuationBinding[] = [
      { ...binding, query: otherQuery },
      { ...binding, query: otherOrdering },
      { ...binding, context: otherUser },
      { ...binding, revisions: indexedState({ catalogRevision: 'catalog-8' }) },
      { ...binding, revisions: indexedState({ privateRevision: '13' }) },
      { ...binding, revisions: indexedState({ privateRevision: null }) },
      { ...binding, revisions: indexedState({ generation: 'generation-2' }) },
      { ...binding, revisions: indexedState({ catalogPosition: '10' }) },
    ];

    for (const stale of staleCases) {
      expect(captureSearchError(() => decodeSearchContinuation(token, stale)).code).toBe(
        'stale-continuation',
      );
    }
  });

  it('leaves the page size free to change between pages', () => {
    const binding = bindingFor(privateQuery());
    const token = encodeSearchContinuation({ ...binding, offset: 20 });
    const resized = { ...binding, query: { ...binding.query, pageSize: 25 } };

    expect(decodeSearchContinuation(token, resized)).toBe(20);
  });

  it('rejects a continuation that is not readable', () => {
    const binding = bindingFor(privateQuery());
    const tokens = [
      '',
      'not a continuation',
      Buffer.from(JSON.stringify({ version: 2 }), 'utf8').toString('base64url'),
      'x'.repeat(SEARCH_LIMITS.maxContinuationLength + 1),
    ];

    for (const token of tokens) {
      expect(captureSearchError(() => decodeSearchContinuation(token, binding)).code).toBe(
        'invalid-request',
      );
    }
  });

  it('refuses to bind a private continuation without trusted context', () => {
    const query = privateQuery();
    const revisions = indexedState();

    expect(
      captureSearchError(() => encodeSearchContinuation({ query, revisions, offset: 0 })).code,
    ).toBe('unauthorized');
    expect(
      captureSearchError(() =>
        encodeSearchContinuation({
          query,
          context: callerInput({ accountId: '' }),
          revisions,
          offset: 0,
        }),
      ).code,
    ).toBe('unauthorized');
  });
});

describe('search result contract', () => {
  it('derives one stable key per typed target', () => {
    expect(searchEntryKey({ kind: 'card', cardId: 'oracle-1' })).toBe('card:oracle-1');
    expect(searchEntryKey({ kind: 'printing', printingId: 'oracle-1' })).toBe('printing:oracle-1');
    expect(searchEntryKey({ kind: 'copy', copyId: 'oracle-1' })).toBe('copy:oracle-1');
  });

  it('keeps an unavailable count and an explicit end distinct from zero and more pages', () => {
    const page: SearchPage = {
      entries: [
        {
          entryKey: searchEntryKey({ kind: 'copy', copyId: 'copy-1' }),
          target: { kind: 'copy', copyId: 'copy-1' },
          card: { cardId: 'oracle-1', name: 'Lightning Bolt', matchedName: 'Blitzschlag' },
          printing: {
            printingId: 'printing-1',
            edition: 'M11',
            collectorNumber: '149',
            language: 'en',
          },
          quantity: { copies: 2, intended: 4 },
        },
      ],
      status: 'ready',
      totalCount: null,
      continuation: null,
      revisions: indexedState(),
    };

    expect(page.totalCount).toBeNull();
    expect(page.continuation).toBeNull();
    expect(page.entries[0]?.quantity).toEqual({ copies: 2, intended: 4 });
  });
});
