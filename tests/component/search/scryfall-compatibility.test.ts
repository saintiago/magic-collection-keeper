/**
 * Component scope: the supported Scryfall subset (docs/search.md#scryfall-compatibility). A
 * supported text expression and the equivalent UI criteria normalize into the same query model,
 * and an expression outside the subset is rejected explicitly instead of being ignored, read as
 * name text or forwarded to an external provider. Evaluation against the published relations
 * belongs to the search evaluation task, so these cases assert the normalized query model.
 */

import { describe, expect, it } from 'vitest';

import {
  SEARCH_LIMITS,
  normalizeSearchRequest,
  parseScryfallQuery,
  searchPublicCriterionLevel,
  type SearchCriterion,
  type SearchFilter,
} from '../../../src/search/index.js';

import { callerInput, captureSearchError } from './harness.js';

function criterionOf(filter: SearchFilter): SearchCriterion {
  if (filter.kind !== 'criterion') {
    throw new Error(`Expected a single criterion, received a ${filter.kind} filter.`);
  }
  return filter.criterion;
}

/** The single criterion one supported expression normalizes to. */
function parsed(expression: string): SearchCriterion {
  return criterionOf(parseScryfallQuery(expression));
}

function criterionFilter(criterion: SearchCriterion): SearchFilter {
  return { kind: 'criterion', criterion };
}

describe('supported search expressions', () => {
  it('reads a loose name word and a name keyword as the same criterion', () => {
    expect(parsed('Bolt')).toEqual({ kind: 'name', text: 'bolt' });
    expect(parsed('name:bolt')).toEqual({ kind: 'name', text: 'bolt' });
    expect(parsed('name:"Lightning Bolt"')).toEqual({ kind: 'name', text: 'lightning bolt' });
  });

  it('reads rules text and type phrases with quoting', () => {
    expect(parsed('o:"draw a card"')).toEqual({ kind: 'rulesText', text: 'draw a card' });
    expect(parsed('oracle:draw')).toEqual({ kind: 'rulesText', text: 'draw' });
    expect(parsed('t:"legendary creature"')).toEqual({
      kind: 'type',
      text: 'legendary creature',
    });
    expect(parsed('type:legend')).toEqual({ kind: 'type', text: 'legend' });
  });

  it('preserves color comparisons and keeps color identity separate', () => {
    expect(parsed('c:wu')).toEqual({ kind: 'color', comparison: '>=', colors: ['W', 'U'] });
    expect(parsed('c=WU')).toEqual({ kind: 'color', comparison: '=', colors: ['W', 'U'] });
    expect(parsed('color>=uw')).toEqual({ kind: 'color', comparison: '>=', colors: ['W', 'U'] });
    expect(parsed('c!=wu')).toEqual({ kind: 'color', comparison: '!=', colors: ['W', 'U'] });
    expect(parsed('id<=wu')).toEqual({
      kind: 'colorIdentity',
      comparison: '<=',
      colors: ['W', 'U'],
    });
    expect(parsed('color_identity:u')).toEqual({
      kind: 'colorIdentity',
      comparison: '>=',
      colors: ['U'],
    });
  });

  it('reads mana value, set, language and finish filters', () => {
    expect(parsed('mv:3')).toEqual({ kind: 'manaValue', comparison: '=', value: 3 });
    expect(parsed('cmc>=2.5')).toEqual({ kind: 'manaValue', comparison: '>=', value: 2.5 });
    expect(parsed('mana_value<1')).toEqual({ kind: 'manaValue', comparison: '<', value: 1 });
    expect(parsed('s:znr')).toEqual({ kind: 'set', edition: 'ZNR' });
    expect(parsed('edition:m11')).toEqual({ kind: 'set', edition: 'M11' });
    expect(parsed('lang:ES')).toEqual({ kind: 'language', language: 'es' });
    expect(parsed('is:nonfoil')).toEqual({ kind: 'finish', finish: 'nonfoil' });
    expect(parsed('is:etched')).toEqual({ kind: 'finish', finish: 'etched' });
  });

  it('normalizes a text expression and the equivalent UI criteria into the same query', () => {
    const fromText = normalizeSearchRequest(
      callerInput({ resultLevel: 'printing', query: 't:ELF set:ZNR c:WU' }),
    );
    const fromControls = normalizeSearchRequest(
      callerInput({
        resultLevel: 'printing',
        criteria: [
          { kind: 'color', comparison: '>=', colors: ['U', 'W'] },
          { kind: 'set', edition: 'znr' },
          { kind: 'type', text: 'Elf' },
        ],
      }),
    );

    expect(fromText.filters).toEqual(fromControls.filters);
    expect(fromText.filters).toEqual([
      criterionFilter({ kind: 'color', comparison: '>=', colors: ['W', 'U'] }),
      criterionFilter({ kind: 'set', edition: 'ZNR' }),
      criterionFilter({ kind: 'type', text: 'elf' }),
    ]);
  });

  it('combines terms with implicit AND, the or keyword and parentheses', () => {
    expect(parseScryfallQuery('t:creature t:artifact')).toEqual({
      kind: 'and',
      operands: [
        criterionFilter({ kind: 'type', text: 'artifact' }),
        criterionFilter({ kind: 'type', text: 'creature' }),
      ],
    });
    expect(parseScryfallQuery('t:creature or t:artifact')).toEqual({
      kind: 'or',
      operands: [
        criterionFilter({ kind: 'type', text: 'artifact' }),
        criterionFilter({ kind: 'type', text: 'creature' }),
      ],
    });
    expect(parseScryfallQuery('t:legendary (t:goblin or t:elf)')).toEqual({
      kind: 'and',
      operands: [
        {
          kind: 'or',
          operands: [
            criterionFilter({ kind: 'type', text: 'elf' }),
            criterionFilter({ kind: 'type', text: 'goblin' }),
          ],
        },
        criterionFilter({ kind: 'type', text: 'legendary' }),
      ],
    });
  });

  it('negates a term or a whole group', () => {
    expect(parseScryfallQuery('-t:creature')).toEqual({
      kind: 'not',
      operand: criterionFilter({ kind: 'type', text: 'creature' }),
    });
    expect(parseScryfallQuery('-(t:goblin or t:elf)')).toEqual({
      kind: 'not',
      operand: {
        kind: 'or',
        operands: [
          criterionFilter({ kind: 'type', text: 'elf' }),
          criterionFilter({ kind: 'type', text: 'goblin' }),
        ],
      },
    });
    expect(parseScryfallQuery('o:draw -c:r')).toEqual({
      kind: 'and',
      operands: [
        {
          kind: 'not',
          operand: criterionFilter({ kind: 'color', comparison: '>=', colors: ['R'] }),
        },
        criterionFilter({ kind: 'rulesText', text: 'draw' }),
      ],
    });
  });

  it('normalizes criteria that differ only in order or spelling to one query', () => {
    const written = normalizeSearchRequest(
      callerInput({ resultLevel: 'card', query: 't:ELF c:WU t:elf' }),
    );
    const reordered = normalizeSearchRequest(
      callerInput({ resultLevel: 'card', query: 'c:wu t:elf' }),
    );

    expect(written.filters).toEqual(reordered.filters);
    expect(written.filters).toEqual([
      criterionFilter({ kind: 'color', comparison: '>=', colors: ['W', 'U'] }),
      criterionFilter({ kind: 'type', text: 'elf' }),
    ]);
  });

  it('keeps card-level and printing-level criteria distinct', () => {
    expect(parseScryfallQuery('t:elf set:znr lang:en is:foil')).toEqual({
      kind: 'and',
      operands: [
        criterionFilter({ kind: 'finish', finish: 'foil' }),
        criterionFilter({ kind: 'language', language: 'en' }),
        criterionFilter({ kind: 'set', edition: 'ZNR' }),
        criterionFilter({ kind: 'type', text: 'elf' }),
      ],
    });
  });

  it('reports whether a public criterion constrains the card or the printing', () => {
    expect(searchPublicCriterionLevel({ kind: 'color', comparison: '>=', colors: ['W'] })).toBe(
      'card',
    );
    expect(searchPublicCriterionLevel({ kind: 'manaValue', comparison: '=', value: 2 })).toBe(
      'card',
    );
    expect(searchPublicCriterionLevel({ kind: 'set', edition: 'ZNR' })).toBe('printing');
    expect(searchPublicCriterionLevel({ kind: 'language', language: 'en' })).toBe('printing');
    expect(searchPublicCriterionLevel({ kind: 'finish', finish: 'foil' })).toBe('printing');
  });
});

describe('unsupported search expressions', () => {
  it.each([
    'is:commander',
    'f:standard',
    'c:colorless',
    'c:blue',
    'c=2',
    'mv:even',
    'mv:three',
    't:/elf/',
    '!"Lightning Bolt"',
    'o:"~ enters tapped"',
    'unique:prints',
    'order:cmc',
    'kw:flying',
    'de:spells',
    '-',
    '()',
    '(t:creature',
    't:creature)',
    'or t:creature',
    't:creature or',
    't:"elf',
  ])('rejects %s and identifies the expression', (expression) => {
    const error = captureSearchError(() => parseScryfallQuery(expression));

    expect(error.code).toBe('unsupported-query');
    expect(error.message).toContain(expression);
  });

  it('never reinterprets an unsupported operator as a name search', () => {
    const error = captureSearchError(() => parseScryfallQuery('is:commander'));

    expect(error.code).toBe('unsupported-query');
    expect(error.message).toContain('is:commander');
  });

  it('rejects an expression longer than the accepted bound', () => {
    const expression = `t:${'x'.repeat(SEARCH_LIMITS.maxQueryLength)}`;
    const error = captureSearchError(() => parseScryfallQuery(expression));

    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain(String(SEARCH_LIMITS.maxQueryLength));
  });

  it('requires a search expression', () => {
    expect(captureSearchError(() => parseScryfallQuery('   ')).code).toBe('invalid-request');
  });
});
