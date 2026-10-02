import { CatalogError } from './errors.js';
import { cardColors, finishes, type CardColor, type Finish, type LanguageCode } from './model.js';

const maxIdentifierLength = 200;
const maxEscapedIdentifierBytes = maxIdentifierLength * 6;

/** Bounds of one public Catalog query and page. */
export const CATALOG_QUERY_LIMITS = {
  maxQueryLength: 500,
  maxTextLength: 300,
  maxCriteria: 50,
  maxIdentifierLength,
  maxEditionLength: 32,
  maxContinuationLength: 4 * Math.ceil((64 + maxEscapedIdentifierBytes + 128) / 3),
  defaultPageSize: 50,
  minPageSize: 1,
  maxPageSize: 100,
} as const;

export const catalogResultLevels = ['card', 'printing'] as const;
export type CatalogResultLevel = (typeof catalogResultLevels)[number];

export const catalogComparisons = ['=', '!=', '>', '>=', '<', '<='] as const;
export type CatalogComparison = (typeof catalogComparisons)[number];

export const catalogOrderingFields = ['name', 'manaValue'] as const;
export type CatalogOrderingField = (typeof catalogOrderingFields)[number];
export const catalogSortDirections = ['ascending', 'descending'] as const;
export type CatalogSortDirection = (typeof catalogSortDirections)[number];

export interface CatalogOrdering {
  readonly field: CatalogOrderingField;
  readonly direction: CatalogSortDirection;
}

export const defaultCatalogOrdering: CatalogOrdering = {
  field: 'name',
  direction: 'ascending',
};

export interface CatalogNameCriterion {
  readonly kind: 'name';
  readonly text: string;
}
export interface CatalogRulesTextCriterion {
  readonly kind: 'rulesText';
  readonly text: string;
}
export interface CatalogTypeCriterion {
  readonly kind: 'type';
  readonly text: string;
}
export type CatalogColorSet = readonly [CardColor, ...CardColor[]];
export interface CatalogColorCriterion {
  readonly kind: 'color';
  readonly comparison: CatalogComparison;
  readonly colors: CatalogColorSet;
}
export interface CatalogColorIdentityCriterion {
  readonly kind: 'colorIdentity';
  readonly comparison: CatalogComparison;
  readonly colors: CatalogColorSet;
}
export interface CatalogManaValueCriterion {
  readonly kind: 'manaValue';
  readonly comparison: CatalogComparison;
  readonly value: number;
}
export interface CatalogSetCriterion {
  readonly kind: 'set';
  readonly edition: string;
}
export interface CatalogLanguageCriterion {
  readonly kind: 'language';
  readonly language: LanguageCode;
}
export interface CatalogFinishCriterion {
  readonly kind: 'finish';
  readonly finish: Finish;
}

export type CatalogCriterion =
  | CatalogNameCriterion
  | CatalogRulesTextCriterion
  | CatalogTypeCriterion
  | CatalogColorCriterion
  | CatalogColorIdentityCriterion
  | CatalogManaValueCriterion
  | CatalogSetCriterion
  | CatalogLanguageCriterion
  | CatalogFinishCriterion;

export function catalogCriterionLevel(criterion: CatalogCriterion): 'card' | 'printing' {
  return criterion.kind === 'set' || criterion.kind === 'language' || criterion.kind === 'finish'
    ? 'printing'
    : 'card';
}

export interface CatalogCriterionFilter {
  readonly kind: 'criterion';
  readonly criterion: CatalogCriterion;
}
export interface CatalogAndFilter {
  readonly kind: 'and';
  readonly operands: readonly CatalogFilter[];
}
export interface CatalogOrFilter {
  readonly kind: 'or';
  readonly operands: readonly CatalogFilter[];
}
export interface CatalogNotFilter {
  readonly kind: 'not';
  readonly operand: CatalogFilter;
}
export type CatalogFilter =
  CatalogCriterionFilter | CatalogAndFilter | CatalogOrFilter | CatalogNotFilter;

export function canonicalCatalogFilter(filter: CatalogFilter): CatalogFilter {
  if (filter.kind === 'criterion') return filter;
  if (filter.kind === 'not') {
    return { kind: 'not', operand: canonicalCatalogFilter(filter.operand) };
  }
  const operands = filter.operands.flatMap((operand) => {
    const canonical = canonicalCatalogFilter(operand);
    return canonical.kind === filter.kind ? canonical.operands : [canonical];
  });
  return combineOperands(filter.kind, operands);
}

export function canonicalizeCatalogFilters(
  filters: readonly CatalogFilter[],
): readonly CatalogFilter[] {
  return orderedOperands(
    'and',
    filters
      .map(canonicalCatalogFilter)
      .flatMap((filter) => (filter.kind === 'and' ? filter.operands : [filter])),
  );
}

export function catalogFilterKey(filter: CatalogFilter): string {
  switch (filter.kind) {
    case 'criterion':
      return JSON.stringify([filter.criterion.kind, criterionKey(filter.criterion)]);
    case 'not':
      return JSON.stringify(['not', JSON.parse(catalogFilterKey(filter.operand))]);
    case 'and':
    case 'or':
      return JSON.stringify([
        filter.kind,
        filter.operands.map((operand) => JSON.parse(catalogFilterKey(operand))),
      ]);
  }
}

function criterionKey(criterion: CatalogCriterion): readonly (string | number)[] {
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
  }
}

function combineOperands(kind: 'and' | 'or', operands: readonly CatalogFilter[]): CatalogFilter {
  const ordered = orderedOperands(kind, operands);
  const [first, ...rest] = ordered;
  if (first === undefined) {
    throw new CatalogError('invalid-request', 'A catalog filter needs at least one operand.');
  }
  return rest.length === 0 ? first : { kind, operands: ordered };
}

function orderedOperands(
  kind: 'and' | 'or',
  operands: readonly CatalogFilter[],
): readonly CatalogFilter[] {
  const unique = new Map<string, CatalogFilter>();
  for (const operand of operands) {
    const flattened = operand.kind === kind ? operand.operands : [operand];
    for (const part of flattened) unique.set(catalogFilterKey(part), part);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, operand]) => operand);
}

export interface CatalogQuery {
  readonly resultLevel: CatalogResultLevel;
  readonly filters: readonly CatalogFilter[];
  readonly ordering: CatalogOrdering;
  readonly pageSize: number;
}

export interface CatalogQueryInput {
  readonly resultLevel: CatalogResultLevel;
  readonly query?: string | null;
  readonly criteria?: readonly CatalogCriterion[] | null;
  readonly ordering?: CatalogOrdering | null;
  readonly pageSize?: number | null;
  readonly continuation?: string | null;
}

export type CatalogCriterionRead =
  | { readonly ok: true; readonly criterion: CatalogCriterion }
  | { readonly ok: false; readonly problem: string };

/** Normalizes one untrusted structured criterion into the public query model. */
export function readCatalogCriterion(value: unknown): CatalogCriterionRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return unreadable('A catalog criterion must be an object.');
  }
  const input = value as Record<string, unknown>;
  switch (input.kind) {
    case 'name':
    case 'rulesText':
    case 'type':
      return readText(input.kind, input.text);
    case 'color':
    case 'colorIdentity':
      return readColors(input.kind, input.comparison, input.colors);
    case 'manaValue':
      return readManaValue(input.comparison, input.value);
    case 'set':
      return readSet(input.edition);
    case 'language':
      return readLanguage(input.language);
    case 'finish':
      return readFinish(input.finish);
    default:
      return unreadable(`A catalog criterion uses the unknown kind "${String(input.kind)}".`);
  }
}

export function isCatalogComparison(value: unknown): value is CatalogComparison {
  return typeof value === 'string' && (catalogComparisons as readonly string[]).includes(value);
}

function readText(kind: 'name' | 'rulesText' | 'type', value: unknown): CatalogCriterionRead {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';
  if (text.length === 0 || text.length > CATALOG_QUERY_LIMITS.maxTextLength) {
    return unreadable(
      `A ${kind} criterion needs 1 to ${CATALOG_QUERY_LIMITS.maxTextLength} characters of text.`,
    );
  }
  return { ok: true, criterion: { kind, text } };
}

function readColors(
  kind: 'color' | 'colorIdentity',
  comparison: unknown,
  value: unknown,
): CatalogCriterionRead {
  if (!isCatalogComparison(comparison)) {
    return unreadable(`A ${kind} criterion needs a supported comparison.`);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > cardColors.length) {
    return unreadable(`A ${kind} criterion needs 1 to ${cardColors.length} color letters.`);
  }
  const selected = new Set<CardColor>();
  for (const color of value) {
    if (typeof color !== 'string' || !(cardColors as readonly string[]).includes(color)) {
      return unreadable(`A ${kind} criterion accepts the color letters W, U, B, R and G.`);
    }
    selected.add(color as CardColor);
  }
  const normalized = cardColors.filter((color) => selected.has(color));
  const [first, ...rest] = normalized;
  if (first === undefined) return unreadable(`A ${kind} criterion needs a color.`);
  return { ok: true, criterion: { kind, comparison, colors: [first, ...rest] } };
}

function readManaValue(comparison: unknown, value: unknown): CatalogCriterionRead {
  if (
    !isCatalogComparison(comparison) ||
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return unreadable(
      'A mana value criterion needs a supported comparison and non-negative number.',
    );
  }
  return { ok: true, criterion: { kind: 'manaValue', comparison, value } };
}

function readSet(value: unknown): CatalogCriterionRead {
  const edition = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (
    !/^[A-Z0-9][A-Z0-9-]*$/.test(edition) ||
    edition.length > CATALOG_QUERY_LIMITS.maxEditionLength
  ) {
    return unreadable('A set criterion needs a supported set code.');
  }
  return { ok: true, criterion: { kind: 'set', edition } };
}

function readLanguage(value: unknown): CatalogCriterionRead {
  const language = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z]{2,3}$/.test(language)
    ? { ok: true, criterion: { kind: 'language', language } }
    : unreadable('A language criterion needs a two- or three-letter language code.');
}

function readFinish(value: unknown): CatalogCriterionRead {
  return typeof value === 'string' && (finishes as readonly string[]).includes(value)
    ? { ok: true, criterion: { kind: 'finish', finish: value as Finish } }
    : unreadable(`A finish criterion accepts ${finishes.join(', ')}.`);
}

function unreadable(problem: string): CatalogCriterionRead {
  return { ok: false, problem };
}
