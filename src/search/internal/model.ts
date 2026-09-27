import {
  cardColors,
  finishes,
  type CardColor,
  type Finish,
  type LanguageCode,
} from '../../catalog/index.js';
import type { TagId } from '../../usercards/index.js';

import { SearchError } from './errors.js';

/**
 * Query model of the Search component (docs/search.md#scryfall-compatibility,
 * docs/search.md#request-and-result).
 *
 * A supported text expression and the equivalent UI controls normalize into the same criteria, so
 * one query model carries the meaning of the request. Card color and color identity stay distinct
 * criterion kinds, and a card-level criterion stays distinct from a printing-level one. Owned
 * status and tag membership are separate structured private criteria; an account is never a query
 * field and reaches Search through trusted context only.
 */

const maxIdentifierLength = 200;
/** JSON escaping can spend six bytes on one string unit of a bound revision or reference. */
const maxEscapedIdentifierBytes = maxIdentifierLength * 6;

/**
 * Bounds that keep a query, its criteria and a page request bounded. A caller that needs more
 * entries reads further pages; Search never silently truncates a page.
 */
export const SEARCH_LIMITS = {
  /** Longest accepted Scryfall-compatible text expression, counted in JavaScript string units. */
  maxQueryLength: 500,
  /** Longest accepted name, rules-text or type value. */
  maxTextLength: 300,
  /** Most structured criteria one request combines, before a text expression adds its own. */
  maxCriteria: 50,
  /** Longest accepted card, printing, copy or tag reference, matching the provider bounds. */
  maxIdentifierLength,
  /** Longest accepted edition (set) code, matching the catalog printing bound. */
  maxEditionLength: 32,
  /** Longest accepted continuation token (see continuation.ts). */
  maxContinuationLength: 4 * Math.ceil((64 + 2 * maxEscapedIdentifierBytes + 64) / 3),
  defaultPageSize: 50,
  minPageSize: 1,
  maxPageSize: 100,
} as const;

/** Result level of a query: one playable card, one printing or one physical copy. */
export const searchResultLevels = ['card', 'printing', 'copy'] as const;
export type SearchResultLevel = (typeof searchResultLevels)[number];

/** Comparison operators of a color, color-identity or mana-value criterion. */
export const searchComparisons = ['=', '!=', '>', '>=', '<', '<='] as const;
export type SearchComparison = (typeof searchComparisons)[number];

export function isSearchComparison(value: unknown): value is SearchComparison {
  return typeof value === 'string' && (searchComparisons as readonly string[]).includes(value);
}

/**
 * Ordering of a query. Evaluation adds a stable identity tie-breaker, so equal values keep one
 * deterministic order across pages (docs/search.md#evaluation-and-grouping).
 */
export const searchOrderingFields = ['name', 'manaValue'] as const;
export type SearchOrderingField = (typeof searchOrderingFields)[number];
export const searchSortDirections = ['ascending', 'descending'] as const;
export type SearchSortDirection = (typeof searchSortDirections)[number];

export interface SearchOrdering {
  readonly field: SearchOrderingField;
  readonly direction: SearchSortDirection;
}

export const defaultSearchOrdering: SearchOrdering = {
  field: 'name',
  direction: 'ascending',
};

/** Case-insensitive comparison form of a name, rules-text or type value. */
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * A playable-identity criterion: the canonical or translated name contains `text`. Text is
 * compared case-insensitively.
 */
export interface SearchNameCriterion {
  readonly kind: 'name';
  readonly text: string;
}

/** A playable-identity criterion: the rules text contains `text`, compared case-insensitively. */
export interface SearchRulesTextCriterion {
  readonly kind: 'rulesText';
  readonly text: string;
}

/**
 * A playable-identity criterion: the type line contains `text`, compared case-insensitively.
 * Partial type words are supported, as in Scryfall: `legend` matches `Legendary`.
 */
export interface SearchTypeCriterion {
  readonly kind: 'type';
  readonly text: string;
}

/** A non-empty set of colors, in W/U/B/R/G order. */
export type SearchColorSet = readonly [CardColor, ...CardColor[]];

/**
 * A playable-identity criterion on card color. `:` normalizes to `>=`, its Scryfall meaning, and
 * `=` is exact equality; the criterion never mixes colors with color identity.
 */
export interface SearchColorCriterion {
  readonly kind: 'color';
  readonly comparison: SearchComparison;
  readonly colors: SearchColorSet;
}

/**
 * A playable-identity criterion on color identity. `:` normalizes to `<=`, its Scryfall meaning:
 * the identity stays within the named colors. Card color keeps `>=`, so the two kinds never share
 * a default.
 */
export interface SearchColorIdentityCriterion {
  readonly kind: 'colorIdentity';
  readonly comparison: SearchComparison;
  readonly colors: SearchColorSet;
}

/** A playable-identity criterion on mana value. `:` normalizes to `=`. */
export interface SearchManaValueCriterion {
  readonly kind: 'manaValue';
  readonly comparison: SearchComparison;
  readonly value: number;
}

/** A printing criterion on the edition (set) code, compared case-insensitively. */
export interface SearchSetCriterion {
  readonly kind: 'set';
  readonly edition: string;
}

/** A printing criterion on the provider language code, compared case-insensitively. */
export interface SearchLanguageCriterion {
  readonly kind: 'language';
  readonly language: LanguageCode;
}

/** A printing criterion on an available finish. */
export interface SearchFinishCriterion {
  readonly kind: 'finish';
  readonly finish: Finish;
}

/** Private criterion: the account owns the physical copies the entry represents. */
export interface SearchOwnedCriterion {
  readonly kind: 'owned';
}

/**
 * Private criterion: membership in one of the account's tags. The tag's own stored kind decides
 * the applicable association levels, so decks, wishlists, locations and other tags are one
 * criterion whose authority stays with UserCards (docs/architecture.md#tags-and-associations).
 */
export interface SearchTagCriterion {
  readonly kind: 'tag';
  readonly tagId: TagId;
}

export type SearchPublicCriterion =
  | SearchNameCriterion
  | SearchRulesTextCriterion
  | SearchTypeCriterion
  | SearchColorCriterion
  | SearchColorIdentityCriterion
  | SearchManaValueCriterion
  | SearchSetCriterion
  | SearchLanguageCriterion
  | SearchFinishCriterion;

export type SearchPrivateCriterion = SearchOwnedCriterion | SearchTagCriterion;

export type SearchCriterion = SearchPublicCriterion | SearchPrivateCriterion;

/**
 * Whether a public criterion constrains the playable card or the printing an entry represents. A
 * printing criterion only matches a related printing of the same entry; card criteria apply at
 * every result level (docs/search.md#scryfall-compatibility).
 */
export function searchPublicCriterionLevel(criterion: SearchPublicCriterion): 'card' | 'printing' {
  switch (criterion.kind) {
    case 'set':
    case 'language':
    case 'finish':
      return 'printing';
    default:
      return 'card';
  }
}

export function isPrivateCriterion(
  criterion: SearchCriterion,
): criterion is SearchPrivateCriterion {
  return criterion.kind === 'owned' || criterion.kind === 'tag';
}

export interface SearchCriterionFilter {
  readonly kind: 'criterion';
  readonly criterion: SearchCriterion;
}

export interface SearchAndFilter {
  readonly kind: 'and';
  /** Every operand must hold; operands are never empty. */
  readonly operands: readonly SearchFilter[];
}

export interface SearchOrFilter {
  readonly kind: 'or';
  /** At least one operand must hold; operands are never empty. */
  readonly operands: readonly SearchFilter[];
}

export interface SearchNotFilter {
  readonly kind: 'not';
  readonly operand: SearchFilter;
}

/** One membership condition of a query, preserving supported operator and combination meaning. */
export type SearchFilter =
  SearchCriterionFilter | SearchAndFilter | SearchOrFilter | SearchNotFilter;

/**
 * Canonical form of one filter. The operands of a commutative combination are flattened, made
 * unique and sorted, so filters that differ only in the order their operands were written
 * normalize to the same value; a combination that keeps one operand collapses to it.
 */
export function canonicalSearchFilter(filter: SearchFilter): SearchFilter {
  if (filter.kind === 'criterion') {
    return filter;
  }
  if (filter.kind === 'not') {
    return { kind: 'not', operand: canonicalSearchFilter(filter.operand) };
  }
  const operands: SearchFilter[] = [];
  for (const operand of filter.operands) {
    const canonical = canonicalSearchFilter(operand);
    if (canonical.kind === filter.kind) {
      operands.push(...canonical.operands);
    } else {
      operands.push(canonical);
    }
  }
  return combineOperands(filter.kind, operands);
}

/** Canonical conjunction of the filters of one query. */
export function canonicalizeSearchFilters(
  filters: readonly SearchFilter[],
): readonly SearchFilter[] {
  return orderedOperands('and', filters.map(canonicalSearchFilter).flatMap(andOperands));
}

/**
 * Canonical serialization of one filter. Filters that mean the same produce the same key; it
 * orders canonical operands and feeds the continuation fingerprint. Each node keeps its kind
 * and payload in separate slots, so node borders and literal values stay distinct. Serialize the
 * complete structural value once: escaping serialized children at every level grows exponentially.
 */
export function searchFilterKey(filter: SearchFilter): string {
  return JSON.stringify(filterKeyValue(filter));
}

function filterKeyValue(filter: SearchFilter): SearchFilterKeyValue {
  switch (filter.kind) {
    case 'criterion':
      return [filter.criterion.kind, criterionKeyValue(filter.criterion)];
    case 'not':
      return ['not', filterKeyValue(filter.operand)];
    case 'and':
    case 'or':
      return [filter.kind, filter.operands.map(filterKeyValue)];
  }
}

/** Structural JSON value, with each node and criterion field in its own slot. */
type SearchFilterKeyValue = readonly (string | number | SearchFilterKeyValue)[];

function criterionKeyValue(criterion: SearchCriterion): SearchFilterKeyValue {
  switch (criterion.kind) {
    case 'name':
    case 'rulesText':
    case 'type':
      return [criterion.text];
    case 'color':
    case 'colorIdentity':
      return [criterion.comparison, criterion.colors.join('')];
    case 'manaValue':
      return [criterion.comparison, criterion.value];
    case 'set':
      return [criterion.edition];
    case 'language':
      return [criterion.language];
    case 'finish':
      return [criterion.finish];
    case 'owned':
      return [];
    case 'tag':
      return [criterion.tagId];
  }
}

/** One canonical combination: operands flattened, made unique and ordered by their key. */
function combineOperands(kind: 'and' | 'or', operands: readonly SearchFilter[]): SearchFilter {
  const ordered = orderedOperands(kind, operands);
  const [first, ...rest] = ordered;
  if (first === undefined) {
    throw new SearchError('invalid-request', 'A search filter needs at least one operand.');
  }
  return rest.length === 0 ? first : { kind, operands: ordered };
}

function orderedOperands(
  kind: 'and' | 'or',
  operands: readonly SearchFilter[],
): readonly SearchFilter[] {
  const unique = new Map<string, SearchFilter>();
  for (const operand of operands) {
    const flat = operand.kind === kind ? operand.operands : [operand];
    for (const part of flat) {
      unique.set(searchFilterKey(part), part);
    }
  }
  const ordered = [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, operand]) => operand);
  return ordered;
}

function andOperands(filter: SearchFilter): readonly SearchFilter[] {
  return filter.kind === 'and' ? filter.operands : [filter];
}

/**
 * One normalized query: the result level, every filter that must hold, the requested ordering and
 * the page size. Ordering and grouping are applied to the complete filtered result before
 * pagination (docs/search.md#evaluation-and-grouping); the page boundary and its continuation
 * stay with the request and are resolved against this query, the user and the read revisions.
 */
export interface SearchQuery {
  readonly resultLevel: SearchResultLevel;
  readonly filters: readonly SearchFilter[];
  readonly ordering: SearchOrdering;
  readonly pageSize: number;
}

/**
 * One search request as Application receives it. Account scope comes from trusted context, not
 * from a field, and a page request carries the continuation of an earlier page of the same query.
 */
export interface SearchRequestInput {
  readonly resultLevel: SearchResultLevel;
  /** Scryfall-compatible text expression; absent or empty for a fully structured request. */
  readonly query?: string | null;
  /** Structured UI criteria; combined with the text expression and each other by AND. */
  readonly criteria?: readonly SearchCriterion[] | null;
  readonly ordering?: SearchOrdering | null;
  readonly pageSize?: number | null;
  /** Continuation returned by an earlier page of the same query, or absent for the first page. */
  readonly continuation?: string | null;
}

/**
 * Provider revisions a page was evaluated against. A continuation is bound to them, so a changed
 * catalog or private revision invalidates it instead of implying an unchanged result
 * (docs/search.md#consistency).
 */
export interface SearchRevisions {
  /** Published catalog revision id the query read. */
  readonly catalogRevision: string;
  /** Bound account's private-data revision; null when the query reads no private data. */
  readonly privateRevision: string | null;
}

/** Result of reading one criterion: the normalized value, or why it cannot be read. */
export type SearchCriterionRead =
  | { readonly ok: true; readonly criterion: SearchCriterion }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads one criterion from untyped input, as a transport caller or the text expression parser can
 * supply it. Values normalize to one canonical form — case-insensitive text and languages,
 * uppercase editions, W/U/B/R/G color order — so equivalent text and UI criteria compare equal.
 */
export function readSearchCriterion(value: unknown): SearchCriterionRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return unreadable('A search criterion must be an object.');
  }
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case 'name':
    case 'rulesText':
    case 'type':
      return readTextCriterion(input.kind, input.text);
    case 'color':
    case 'colorIdentity':
      return readColorCriterion(input.kind, input.comparison, input.colors);
    case 'manaValue':
      return readManaValueCriterion(input.comparison, input.value);
    case 'set':
      return readSetCriterion(input.edition);
    case 'language':
      return readLanguageCriterion(input.language);
    case 'finish':
      return readFinishCriterion(input.finish);
    case 'owned':
      return { ok: true, criterion: { kind: 'owned' } };
    case 'tag':
      return readTagCriterion(input.tagId);
    default:
      return unreadable(`A search criterion uses the unknown kind "${String(input.kind)}".`);
  }
}

/**
 * Whether a query reads private data and therefore needs authenticated context: a physical-copy
 * result level or any private criterion at any level (docs/search.md#request-and-result).
 */
export function requiresTrustedContext(query: SearchQuery): boolean {
  return query.resultLevel === 'copy' || query.filters.some(filterUsesPrivateCriterion);
}

function filterUsesPrivateCriterion(filter: SearchFilter): boolean {
  switch (filter.kind) {
    case 'criterion':
      return isPrivateCriterion(filter.criterion);
    case 'and':
    case 'or':
      return filter.operands.some(filterUsesPrivateCriterion);
    case 'not':
      return filterUsesPrivateCriterion(filter.operand);
  }
}

function readTextCriterion(
  kind: 'name' | 'rulesText' | 'type',
  value: unknown,
): SearchCriterionRead {
  if (typeof value !== 'string') {
    return unreadable(`A ${kind} criterion needs a text value.`);
  }
  const text = normalizeText(value);
  if (text.length === 0 || text.length > SEARCH_LIMITS.maxTextLength) {
    return unreadable(
      `A ${kind} criterion needs 1 to ${SEARCH_LIMITS.maxTextLength} characters of text.`,
    );
  }
  return { ok: true, criterion: { kind, text } };
}

function readColorCriterion(
  kind: 'color' | 'colorIdentity',
  comparison: unknown,
  value: unknown,
): SearchCriterionRead {
  if (!isSearchComparison(comparison)) {
    return unreadable(
      `A ${kind} criterion needs one of the comparisons ${searchComparisons.join(', ')}.`,
    );
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > cardColors.length) {
    return unreadable(`A ${kind} criterion needs 1 to ${cardColors.length} color letters.`);
  }
  const selected = new Set<CardColor>();
  for (const color of value) {
    if (!isCardColor(color)) {
      return unreadable(`A ${kind} criterion accepts the color letters W, U, B, R and G.`);
    }
    selected.add(color);
  }
  const colors = cardColors.filter((color) => selected.has(color));
  const [first, ...rest] = colors;
  if (first === undefined) {
    return unreadable(`A ${kind} criterion needs 1 to ${cardColors.length} color letters.`);
  }
  return { ok: true, criterion: { kind, comparison, colors: [first, ...rest] } };
}

function readManaValueCriterion(comparison: unknown, value: unknown): SearchCriterionRead {
  if (!isSearchComparison(comparison)) {
    return unreadable(
      `A mana value criterion needs one of the comparisons ${searchComparisons.join(', ')}.`,
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return unreadable('A mana value criterion needs a non-negative number.');
  }
  return { ok: true, criterion: { kind: 'manaValue', comparison, value } };
}

function readSetCriterion(value: unknown): SearchCriterionRead {
  const edition = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(edition) || edition.length > SEARCH_LIMITS.maxEditionLength) {
    return unreadable(
      `A set criterion needs a set code of 1 to ${SEARCH_LIMITS.maxEditionLength} letters, digits or hyphens.`,
    );
  }
  return { ok: true, criterion: { kind: 'set', edition } };
}

function readLanguageCriterion(value: unknown): SearchCriterionRead {
  const language = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z]{2,3}$/.test(language)) {
    return unreadable('A language criterion needs a two- or three-letter language code.');
  }
  return { ok: true, criterion: { kind: 'language', language } };
}

function readFinishCriterion(value: unknown): SearchCriterionRead {
  if (typeof value !== 'string' || !(finishes as readonly string[]).includes(value)) {
    return unreadable(`A finish criterion accepts ${finishes.join(', ')}.`);
  }
  return { ok: true, criterion: { kind: 'finish', finish: value as Finish } };
}

function readTagCriterion(value: unknown): SearchCriterionRead {
  const tagId = typeof value === 'string' ? value : '';
  if (tagId.length === 0 || tagId.length > SEARCH_LIMITS.maxIdentifierLength) {
    return unreadable(
      `A tag criterion needs a tag identity of 1 to ${maxIdentifierLength} characters.`,
    );
  }
  return { ok: true, criterion: { kind: 'tag', tagId } };
}

function isCardColor(value: unknown): value is CardColor {
  return typeof value === 'string' && (cardColors as readonly string[]).includes(value);
}

function unreadable(problem: string): SearchCriterionRead {
  return { ok: false, problem };
}
