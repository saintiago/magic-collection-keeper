import { finishes, type Finish } from '../../catalog/index.js';

import { SearchError } from './errors.js';
import {
  SEARCH_LIMITS,
  canonicalSearchFilter,
  isSearchComparison,
  readSearchCriterion,
  type SearchComparison,
  type SearchFilter,
} from './model.js';

/**
 * The supported subset of Scryfall's public search syntax (docs/search.md#scryfall-compatibility).
 *
 * Supported: loose name words, `name:`, `oracle:`/`o:`, `type:`/`t:`, `color:`/`c:` (a colon
 * means at least the named colors), `color_identity:`/`identity:`/`id:` (a colon means at most the
 * named colors), `mana_value:`/`mv:`/`cmc:` (a colon means exactly), `set:`/`s:`/`e:`/`edition:`,
 * `lang:`/`language:`, the finish keywords `is:foil`, `is:nonfoil` and `is:etched`, explicit
 * comparison operators, quoted values, implicit AND, the `or` keyword, parentheses and `-`
 * negation. Operators, comparisons, values and combinations outside this subset are rejected with
 * an explicit unsupported-query error naming the expression; they are never ignored, reinterpreted
 * as name text or forwarded to an external provider.
 */
export function parseScryfallQuery(text: string): SearchFilter {
  if (typeof text !== 'string') {
    throw new SearchError('invalid-request', 'A search expression must be a string.');
  }
  const expression = text.trim();
  if (expression.length === 0) {
    throw new SearchError('invalid-request', 'A search expression is required.');
  }
  if (expression.length > SEARCH_LIMITS.maxQueryLength) {
    throw new SearchError(
      'invalid-request',
      `A search expression of at most ${SEARCH_LIMITS.maxQueryLength} characters is required.`,
    );
  }
  return parseTokens(tokenize(expression), expression);
}

type SearchToken =
  | { readonly kind: 'term'; readonly text: string }
  | { readonly kind: 'paren'; readonly value: '(' | ')' };

function tokenize(expression: string): readonly SearchToken[] {
  const tokens: SearchToken[] = [];
  let current = '';
  let quoted = false;
  let regex = false;
  const flush = (): void => {
    if (current !== '') {
      tokens.push({ kind: 'term', text: current });
      current = '';
    }
  };
  for (const character of expression) {
    if (regex) {
      // A `/…/` value stays one term up to its closing delimiter, so its whitespace, quotes and
      // parentheses are never split into separate search terms before it is rejected.
      current += character;
      if (character === '/') {
        throw unsupportedRegex(current);
      }
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (!quoted && (character === '(' || character === ')')) {
      flush();
      tokens.push({ kind: 'paren', value: character });
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      flush();
      continue;
    }
    if (!quoted && character === '/' && endsAtComparison(current)) {
      regex = true;
    }
    current += character;
  }
  if (regex) {
    throw unsupportedRegex(current);
  }
  if (quoted) {
    throw unsupported(expression, 'The expression contains an unterminated quote.');
  }
  flush();
  return tokens;
}

/**
 * Whether one term buffer ends exactly at its first comparison outside quotes. A `/` directly
 * after it opens a regular-expression value (docs/search.md#scryfall-compatibility).
 */
function endsAtComparison(term: string): boolean {
  const comparison = findComparison(term);
  return comparison !== null && comparison.operator !== '!' && comparison.end === term.length;
}

function parseTokens(tokens: readonly SearchToken[], expression: string): SearchFilter {
  let position = 0;

  function peek(): SearchToken | undefined {
    return tokens[position];
  }

  function isOrKeyword(token: SearchToken | undefined): boolean {
    return token?.kind === 'term' && token.text.toLowerCase() === 'or';
  }

  function parseOr(): SearchFilter {
    const operands: SearchFilter[] = [parseAnd()];
    while (isOrKeyword(peek())) {
      position += 1;
      operands.push(parseAnd());
    }
    return combine('or', operands);
  }

  function parseAnd(): SearchFilter {
    const operands: SearchFilter[] = [];
    while (position < tokens.length && !isCloseParen(peek()) && !isOrKeyword(peek())) {
      operands.push(parseUnary());
    }
    if (operands.length === 0) {
      throw unsupported(expression, 'A group or the whole expression contains no search term.');
    }
    return combine('and', operands);
  }

  function isCloseParen(token: SearchToken | undefined): boolean {
    return token?.kind === 'paren' && token.value === ')';
  }

  function parseUnary(): SearchFilter {
    const token = peek();
    if (token === undefined) {
      throw unsupported(expression, 'The expression ends before a search term.');
    }
    if (token.kind === 'paren') {
      if (token.value === ')') {
        throw unsupported(expression, 'The expression contains an unmatched closing parenthesis.');
      }
      position += 1;
      const group = parseOr();
      const closing = peek();
      if (closing?.kind !== 'paren' || closing.value !== ')') {
        throw unsupported(expression, 'The expression contains an unclosed parenthesis.');
      }
      position += 1;
      return group;
    }
    position += 1;
    if (token.text === '-') {
      return { kind: 'not', operand: parseUnary() };
    }
    if (token.text.startsWith('-')) {
      return { kind: 'not', operand: predicateFilter(token.text.slice(1)) };
    }
    return predicateFilter(token.text);
  }

  const filter = parseOr();
  if (position < tokens.length) {
    throw unsupported(expression, 'The expression contains an unmatched closing parenthesis.');
  }
  return filter;
}

function combine(kind: 'and' | 'or', operands: readonly SearchFilter[]): SearchFilter {
  const [first, ...rest] = operands;
  if (first === undefined) {
    // Both parsers only call combine with at least one operand.
    throw new SearchError('unsupported-query', 'The expression contains no search term.');
  }
  return rest.length === 0 ? first : canonicalSearchFilter({ kind, operands });
}

function predicateFilter(term: string): SearchFilter {
  const { key, operator, value: raw } = splitOperator(term);
  const value = readTermValue(raw, term);
  if (key === null) {
    return criterionFilter({ kind: 'name', text: value }, term);
  }
  if (/^\/.*\/$/su.test(value)) {
    throw unsupportedRegex(term);
  }
  const name = key.toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
    throw unsupported(term, `The search key "${key}" is not supported.`);
  }
  switch (name) {
    case 'name':
      return textCriterion('name', operator, value, term);
    case 'oracle':
    case 'o':
      return rulesTextCriterion(operator, value, term);
    case 'type':
    case 't':
      return textCriterion('type', operator, value, term);
    case 'color':
    case 'c':
      return colorCriterion('color', operator, value, term);
    case 'color_identity':
    case 'identity':
    case 'id':
      return colorCriterion('colorIdentity', operator, value, term);
    case 'mana_value':
    case 'mv':
    case 'cmc':
      return manaValueCriterion(operator, value, term);
    case 'set':
    case 's':
    case 'e':
    case 'edition':
      return setCriterion(operator, value, term);
    case 'lang':
    case 'language':
      return languageCriterion(operator, value, term);
    case 'is':
      return finishCriterion(operator, value, term);
    default:
      throw unsupported(term, `The search key "${key}" is not supported.`);
  }
}

interface SplitTerm {
  readonly key: string | null;
  readonly operator: string | null;
  readonly value: string;
}

/** The first comparison of one term, outside quotes: its operator text and the index after it. */
interface TermComparison {
  readonly operator: string;
  readonly end: number;
}

/**
 * Finds the comparison a term is split at, so splitting and the unsupported-regex check read the
 * same operator vocabulary. A lone `!` is returned as its own operator and rejected by the caller.
 */
function findComparison(term: string): TermComparison | null {
  const twoCharacter = ['!=', '>=', '<='];
  const oneCharacter = [':', '=', '>', '<', '!'];
  let quoted = false;
  for (let index = 0; index < term.length; index += 1) {
    const character = term.charAt(index);
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    const pair = term.slice(index, index + 2);
    if (twoCharacter.includes(pair)) {
      return { operator: pair, end: index + 2 };
    }
    if (oneCharacter.includes(character)) {
      return { operator: character, end: index + 1 };
    }
  }
  return null;
}

/**
 * Splits one term at its first comparison outside quotes. A term without a comparison is a loose
 * name word, exactly as Scryfall reads it; `!` never silently becomes name text.
 */
function splitOperator(term: string): SplitTerm {
  const comparison = findComparison(term);
  if (comparison === null) {
    return { key: null, operator: null, value: term };
  }
  if (comparison.operator === '!') {
    throw unsupported(term, 'Exact-name matching with "!" is not supported.');
  }
  return {
    key: term.slice(0, comparison.end - comparison.operator.length),
    operator: comparison.operator,
    value: term.slice(comparison.end),
  };
}

function readTermValue(raw: string, term: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw unsupported(term, 'The expression has no value.');
  }
  if (value.startsWith('"') || value.endsWith('"')) {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
      throw unsupported(term, 'A quoted value must be quoted as a whole.');
    }
    const inner = value.slice(1, -1);
    if (inner.includes('"')) {
      throw unsupported(term, 'A quoted value cannot contain another quote.');
    }
    return inner;
  }
  if (value.includes('"')) {
    throw unsupported(term, 'A quoted value must be quoted as a whole.');
  }
  return value;
}

function textCriterion(
  kind: 'name' | 'type',
  operator: string | null,
  value: string,
  term: string,
): SearchFilter {
  if (operator !== ':') {
    throw unsupported(term, `The ${kind} filter only supports ":" comparisons.`);
  }
  return criterionFilter({ kind, text: value }, term);
}

function rulesTextCriterion(operator: string | null, value: string, term: string): SearchFilter {
  if (operator !== ':') {
    throw unsupported(term, 'The rules text filter only supports ":" comparisons.');
  }
  if (value.includes('~')) {
    throw unsupported(term, 'The "~" card-name placeholder is not supported.');
  }
  return criterionFilter({ kind: 'rulesText', text: value }, term);
}

function colorCriterion(
  kind: 'color' | 'colorIdentity',
  operator: string | null,
  value: string,
  term: string,
): SearchFilter {
  return criterionFilter(
    {
      kind,
      comparison: comparisonFor(operator, colonComparison[kind], term),
      colors: [...value.toUpperCase()],
    },
    term,
  );
}

/**
 * Meaning of a `:` comparison: card color selects cards that are at least the named colors, while
 * color identity selects cards whose identity is at most the named colors, so the two criteria
 * never share a default (docs/search.md#scryfall-compatibility).
 */
const colonComparison: Record<'color' | 'colorIdentity', SearchComparison> = {
  color: '>=',
  colorIdentity: '<=',
};

function manaValueCriterion(operator: string | null, value: string, term: string): SearchFilter {
  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(value)) {
    throw unsupported(term, 'A mana value filter needs a non-negative number.');
  }
  return criterionFilter(
    { kind: 'manaValue', comparison: comparisonFor(operator, '=', term), value: Number(value) },
    term,
  );
}

function setCriterion(operator: string | null, value: string, term: string): SearchFilter {
  if (operator !== ':') {
    throw unsupported(term, 'The set filter only supports ":" comparisons.');
  }
  return criterionFilter({ kind: 'set', edition: value.toUpperCase() }, term);
}

function languageCriterion(operator: string | null, value: string, term: string): SearchFilter {
  if (operator !== ':') {
    throw unsupported(term, 'The language filter only supports ":" comparisons.');
  }
  return criterionFilter({ kind: 'language', language: value.toLowerCase() }, term);
}

function finishCriterion(operator: string | null, value: string, term: string): SearchFilter {
  if (operator !== ':') {
    throw unsupported(term, 'The finish filter only supports ":" comparisons.');
  }
  const finish = value.toLowerCase();
  if (!(finishes as readonly string[]).includes(finish)) {
    throw unsupported(term, `The "is:" key supports the finishes ${finishes.join(', ')} only.`);
  }
  return criterionFilter({ kind: 'finish', finish: finish as Finish }, term);
}

function comparisonFor(
  operator: string | null,
  colon: SearchComparison,
  term: string,
): SearchComparison {
  if (operator === ':') {
    return colon;
  }
  if (isSearchComparison(operator)) {
    return operator;
  }
  throw unsupported(term, `The comparison "${operator ?? ''}" is not supported.`);
}

function criterionFilter(candidate: unknown, term: string): SearchFilter {
  const read = readSearchCriterion(candidate);
  if (!read.ok) {
    throw unsupported(term, read.problem);
  }
  return { kind: 'criterion', criterion: read.criterion };
}

function unsupported(term: string, problem: string): SearchError {
  return new SearchError(
    'unsupported-query',
    `The search expression "${term}" is not supported. ${problem}`,
  );
}

/** Rejection of a `/…/` regular-expression value, which this subset does not evaluate. */
function unsupportedRegex(expression: string): SearchError {
  return unsupported(expression, 'Regular expression matching is not supported.');
}
