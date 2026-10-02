import { createHash } from 'node:crypto';

import { z } from 'zod';

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor, CatalogSqlRow, CatalogSqlValue } from './executor.js';
import type { CardRecord, CatalogRevision, PrintingRecord } from './model.js';
import {
  CATALOG_QUERY_LIMITS,
  canonicalizeCatalogFilters,
  catalogCriterionLevel,
  catalogFilterKey,
  catalogOrderingFields,
  catalogResultLevels,
  catalogSortDirections,
  defaultCatalogOrdering,
  readCatalogCriterion,
  type CatalogColorCriterion,
  type CatalogColorIdentityCriterion,
  type CatalogCriterion,
  type CatalogFilter,
  type CatalogQuery,
  type CatalogQueryInput,
  type CatalogResultLevel,
} from './query-model.js';
import { parseScryfallQuery } from './query-language.js';
import {
  cardJsonSchema,
  parseJsonText,
  printingJsonSchema,
  revisionFromJson,
  revisionJsonExpression,
  revisionJsonSchema,
} from './records.js';

export type CatalogEntryTarget =
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'printing'; readonly printingId: string };

export function catalogEntryKey(target: CatalogEntryTarget): string {
  return target.kind === 'card' ? `card:${target.cardId}` : `printing:${target.printingId}`;
}

export interface CatalogEntryCard extends CardRecord {
  /** Translated or face name that matched instead of the canonical name. */
  readonly matchedName: string | null;
}

export interface CatalogEntry {
  readonly entryKey: string;
  readonly target: CatalogEntryTarget;
  readonly card: CatalogEntryCard;
  readonly printing: PrintingRecord | null;
}

export interface CatalogQueryPage {
  readonly entries: readonly CatalogEntry[];
  readonly totalCount: number;
  readonly revision: CatalogRevision;
  readonly continuation: string | null;
}

const requestSchema = z.object({
  resultLevel: z.enum(catalogResultLevels),
  query: z.string().max(CATALOG_QUERY_LIMITS.maxQueryLength).nullable().optional(),
  criteria: z.array(z.unknown()).max(CATALOG_QUERY_LIMITS.maxCriteria).nullable().optional(),
  ordering: z
    .object({
      field: z.enum(catalogOrderingFields),
      direction: z.enum(catalogSortDirections),
    })
    .nullable()
    .optional(),
  pageSize: z
    .number()
    .int()
    .min(CATALOG_QUERY_LIMITS.minPageSize)
    .max(CATALOG_QUERY_LIMITS.maxPageSize)
    .nullable()
    .optional(),
  continuation: z
    .string()
    .min(1)
    .max(CATALOG_QUERY_LIMITS.maxContinuationLength)
    .nullable()
    .optional(),
});

export function normalizeCatalogQuery(request: CatalogQueryInput): CatalogQuery {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    throw new CatalogError('invalid-request', requestProblem(parsed.error));
  }
  const filters: CatalogFilter[] = [];
  const text = parsed.data.query?.trim() ?? '';
  if (text !== '') {
    const expression = parseScryfallQuery(text);
    filters.push(...(expression.kind === 'and' ? expression.operands : [expression]));
  }
  for (const candidate of parsed.data.criteria ?? []) {
    const read = readCatalogCriterion(candidate);
    if (!read.ok) throw new CatalogError('invalid-request', read.problem);
    filters.push({ kind: 'criterion', criterion: read.criterion });
  }
  return {
    resultLevel: parsed.data.resultLevel,
    filters: canonicalizeCatalogFilters(filters),
    ordering: parsed.data.ordering ?? defaultCatalogOrdering,
    pageSize: parsed.data.pageSize ?? CATALOG_QUERY_LIMITS.defaultPageSize,
  };
}

function requestProblem(error: z.ZodError): string {
  switch (error.issues[0]?.path[0]) {
    case 'resultLevel':
      return 'A catalog result level of card or printing is required.';
    case 'query':
      return `A catalog expression of at most ${CATALOG_QUERY_LIMITS.maxQueryLength} characters is required.`;
    case 'criteria':
      return `A catalog query carries at most ${CATALOG_QUERY_LIMITS.maxCriteria} structured criteria.`;
    case 'ordering':
      return 'Catalog ordering needs a supported field and direction.';
    case 'pageSize':
      return `A catalog page size from ${CATALOG_QUERY_LIMITS.minPageSize} to ${CATALOG_QUERY_LIMITS.maxPageSize} is required.`;
    case 'continuation':
      return 'This continuation is not readable; start the catalog query again.';
    default:
      return 'A catalog query with a result level is required.';
  }
}

interface Cursor {
  readonly version: 1;
  readonly fingerprint: string;
  readonly revision: string;
  readonly offset: number;
}

const cursorSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().length(64),
  revision: z.string().min(1).max(CATALOG_QUERY_LIMITS.maxIdentifierLength),
  offset: z.number().int().min(0),
});

function readCursor(token: string): Cursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadableContinuation();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw unreadableContinuation();
  return parsed.data;
}

function unreadableContinuation(): CatalogError {
  return new CatalogError(
    'invalid-request',
    'This continuation is not readable; start the catalog query again.',
  );
}

function queryFingerprint(query: CatalogQuery): string {
  const canonical = JSON.stringify({
    version: 1,
    resultLevel: query.resultLevel,
    ordering: `${query.ordering.field}:${query.ordering.direction}`,
    pageSize: query.pageSize,
    filters: canonicalizeCatalogFilters(query.filters).map(catalogFilterKey),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function encodeCursor(query: CatalogQuery, revision: string, offset: number): string {
  const cursor: Cursor = {
    version: 1,
    fingerprint: queryFingerprint(query),
    revision,
    offset,
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

interface SqlContext {
  readonly card: string;
  readonly printing: string | null;
  readonly bind: (value: CatalogSqlValue) => string;
  readonly alias: (prefix: string) => string;
}

interface QueryStatement {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, CatalogSqlValue>>;
}

type NameScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'canonical' }
  | { readonly kind: 'candidate'; readonly name: string };

function pageStatement(query: CatalogQuery, offset: number, limit: number): QueryStatement {
  const parameters: Record<string, CatalogSqlValue> = {};
  let parameterCount = 0;
  let aliasCount = 0;
  const bind = (value: CatalogSqlValue): string => {
    const name = `catalog_query_${parameterCount++}`;
    parameters[name] = value;
    return `:${name}`;
  };
  const alias = (prefix: string): string => `${prefix}_${++aliasCount}`;
  const context: SqlContext = {
    card: 'card',
    printing: query.resultLevel === 'printing' ? 'printing' : null,
    bind,
    alias,
  };
  const entryId = query.resultLevel === 'card' ? 'card.card_id' : 'printing.printing_id';
  const from =
    query.resultLevel === 'card'
      ? 'catalog.cards as card'
      : 'catalog.printings as printing join catalog.cards as card on card.card_id = printing.card_id';
  const printing =
    query.resultLevel === 'card'
      ? 'null::text'
      : `to_jsonb((select value from (select printing.printing_id, printing.card_id,
           printing.edition, printing.collector_number, printing.language, printing.finishes,
           printing.physical, printing.image_small, printing.image_normal, printing.image_large,
           printing.image_art_crop) as value))::text`;
  const orderBy =
    query.ordering.field === 'name'
      ? `lower(card_name) ${query.ordering.direction === 'descending' ? 'desc' : 'asc'}, entry_id asc`
      : `mana_value ${query.ordering.direction === 'descending' ? 'desc' : 'asc'} nulls last, entry_id asc`;
  const where = filterSqls(query.filters, context);
  const statement = `with matched as (
  select
    ${entryId} as entry_id,
    to_jsonb((select value from (select card.card_id, card.name, card.rules_text, card.type_line,
      card.colors, card.color_identity, card.mana_value) as value))::text as card,
    coalesce((select jsonb_agg(jsonb_build_object('language', alias.language, 'name', alias.name)
      order by alias.language, alias.name)::text from catalog.card_names as alias
      where alias.card_id = card.card_id), '[]') as names,
    card.name as card_name,
    card.mana_value as mana_value,
    ${matchedNameSql(query.filters, context)} as matched_name,
    ${printing} as printing
  from ${from}
  where ${where}
),
page as (
  select * from matched order by ${orderBy} limit :page_limit offset :page_offset
)
select 'entry' as row_kind,
  (row_number() over (order by ${orderBy}))::int as row_position,
  entry_id, card, names, matched_name, printing,
  null::text as revision, null::int as total_count
from page
union all
select 'state' as row_kind, 0 as row_position,
  null::text as entry_id, null::text as card, null::text as names,
  null::text as matched_name, null::text as printing,
  ${revisionJsonExpression} as revision,
  (select count(*)::int from matched) as total_count
from catalog.published_revision as revision
order by row_kind desc, row_position`;
  parameters.page_limit = limit;
  parameters.page_offset = offset;
  return { statement, parameters };
}

/** A card query chooses one related printing for the complete filter expression. */
function filterSqls(
  filters: readonly CatalogFilter[],
  context: SqlContext,
  nameScope: NameScope = { kind: 'all' },
): string {
  if (filters.length === 0) return 'true';
  if (context.printing !== null) {
    return boundFiltersSql(filters, context, context.printing, nameScope);
  }
  const parts = [boundFiltersSql(filters, context, null, nameScope)];
  if (filters.some(filterUsesPrinting)) {
    const printing = context.alias('related_printing');
    parts.push(
      `exists (select 1 from catalog.printings as ${printing}` +
        ` where ${printing}.card_id = ${context.card}.card_id` +
        ` and ${boundFiltersSql(filters, context, printing, nameScope)})`,
    );
  }
  return `(${parts.join(' or ')})`;
}

function filterUsesPrinting(filter: CatalogFilter): boolean {
  switch (filter.kind) {
    case 'criterion':
      return catalogCriterionLevel(filter.criterion) === 'printing';
    case 'not':
      return filterUsesPrinting(filter.operand);
    case 'and':
    case 'or':
      return filter.operands.some(filterUsesPrinting);
  }
}

function boundFiltersSql(
  filters: readonly CatalogFilter[],
  context: SqlContext,
  printing: string | null,
  nameScope: NameScope,
): string {
  return `(${filters
    .map((filter) => boundFilterSql(filter, context, printing, nameScope))
    .join(' and ')})`;
}

function boundFilterSql(
  filter: CatalogFilter,
  context: SqlContext,
  printing: string | null,
  nameScope: NameScope,
): string {
  switch (filter.kind) {
    case 'criterion':
      return criterionSql(filter.criterion, context, printing, nameScope);
    case 'not':
      return `not (${boundFilterSql(filter.operand, context, printing, nameScope)})`;
    case 'or':
      return `(${filter.operands
        .map((part) => boundFilterSql(part, context, printing, nameScope))
        .join(' or ')})`;
    case 'and':
      return boundFiltersSql(filter.operands, context, printing, nameScope);
  }
}

function criterionSql(
  criterion: CatalogCriterion,
  context: SqlContext,
  printing: string | null,
  nameScope: NameScope,
): string {
  switch (criterion.kind) {
    case 'name': {
      const value = context.bind(criterion.text);
      const canonical = `strpos(lower(${context.card}.name), ${value}) > 0`;
      if (nameScope.kind === 'canonical') return canonical;
      if (nameScope.kind === 'candidate') {
        return `(${canonical} or strpos(lower(${nameScope.name}), ${value}) > 0)`;
      }
      const name = context.alias('name_alias');
      return (
        `(${canonical} or exists (` +
        `select 1 from catalog.card_names as ${name} where ${name}.card_id = ${context.card}.card_id` +
        ` and strpos(lower(${name}.name), ${value}) > 0))`
      );
    }
    case 'rulesText':
      return textSql(`${context.card}.rules_text`, criterion.text, context);
    case 'type':
      return textSql(`${context.card}.type_line`, criterion.text, context);
    case 'color':
      return colorSql(`${context.card}.colors`, criterion, context);
    case 'colorIdentity':
      return colorSql(`${context.card}.color_identity`, criterion, context);
    case 'manaValue': {
      const operator = criterion.comparison === '!=' ? '<>' : criterion.comparison;
      return `(${context.card}.mana_value is not null and ${context.card}.mana_value ${operator} ${context.bind(criterion.value)})`;
    }
    case 'set':
      return printing === null
        ? 'null::boolean'
        : `upper(${printing}.edition) = ${context.bind(criterion.edition)}`;
    case 'language':
      return printing === null
        ? 'null::boolean'
        : `lower(${printing}.language) = ${context.bind(criterion.language)}`;
    case 'finish':
      return printing === null
        ? 'null::boolean'
        : `${context.bind(criterion.finish)} = any(${printing}.finishes)`;
  }
}

function textSql(column: string, text: string, context: SqlContext): string {
  return `strpos(lower(coalesce(${column}, '')), ${context.bind(text)}) > 0`;
}

function colorSql(
  column: string,
  criterion: CatalogColorCriterion | CatalogColorIdentityCriterion,
  context: SqlContext,
): string {
  const selected = `array[${criterion.colors.map((color) => context.bind(color)).join(', ')}]::text[]`;
  const size = criterion.colors.length;
  switch (criterion.comparison) {
    case '=':
      return `(${column} @> ${selected} and ${column} <@ ${selected})`;
    case '!=':
      return `not (${column} @> ${selected} and ${column} <@ ${selected})`;
    case '>=':
      return `${column} @> ${selected}`;
    case '>':
      return `(${column} @> ${selected} and cardinality(${column}) > ${size})`;
    case '<=':
      return `${column} <@ ${selected}`;
    case '<':
      return `(${column} <@ ${selected} and cardinality(${column}) < ${size})`;
  }
}

function matchedNameSql(filters: readonly CatalogFilter[], context: SqlContext): string {
  if (!filters.some((filter) => filterUsesPositiveName(filter))) return 'null::text';
  const canonical = filterSqls(filters, context, { kind: 'canonical' });
  const name = context.alias('matched_name');
  const translated = filterSqls(filters, context, { kind: 'candidate', name: `${name}.name` });
  return (
    `case when ${canonical} then null::text else (` +
    `select ${name}.name from catalog.card_names as ${name}` +
    ` where ${name}.card_id = ${context.card}.card_id and ${translated}` +
    ` order by lower(${name}.name), ${name}.language, ${name}.name limit 1) end`
  );
}

function filterUsesPositiveName(filter: CatalogFilter, negated = false): boolean {
  switch (filter.kind) {
    case 'criterion':
      return !negated && filter.criterion.kind === 'name';
    case 'not':
      return filterUsesPositiveName(filter.operand, !negated);
    case 'and':
    case 'or':
      return filter.operands.some((operand) => filterUsesPositiveName(operand, negated));
  }
}

const entryRowSchema = z.object({
  row_kind: z.literal('entry'),
  entry_id: z.string().min(1).max(CATALOG_QUERY_LIMITS.maxIdentifierLength),
  card: z.string(),
  names: z.string(),
  matched_name: z.string().min(1).max(300).nullable(),
  printing: z.string().nullable(),
});

const stateRowSchema = z.object({
  row_kind: z.literal('state'),
  revision: z.string(),
  total_count: z.number().int().min(0),
});

function readPage(
  rows: readonly CatalogSqlRow[],
  level: CatalogResultLevel,
): {
  readonly entries: readonly CatalogEntry[];
  readonly totalCount: number;
  readonly revision: CatalogRevision;
} {
  const entries: CatalogEntry[] = [];
  let state: { totalCount: number; revision: CatalogRevision } | null = null;
  for (const row of rows) {
    if (row.row_kind === 'entry') {
      const parsed = entryRowSchema.safeParse(row);
      if (!parsed.success) throw unreadableResult();
      const card = parseJsonText(cardJsonSchema, parsed.data.card);
      const names = parseJsonText(
        z.array(
          z.object({
            language: z.string().min(1).max(20),
            name: z.string().min(1).max(300),
          }),
        ),
        parsed.data.names,
      );
      const printing =
        parsed.data.printing === null
          ? null
          : parseJsonText(printingJsonSchema, parsed.data.printing);
      if ((level === 'card') !== (printing === null)) throw unreadableResult();
      const target: CatalogEntryTarget =
        level === 'card'
          ? { kind: 'card', cardId: parsed.data.entry_id }
          : { kind: 'printing', printingId: parsed.data.entry_id };
      if (card.card_id !== (printing?.card_id ?? parsed.data.entry_id)) throw unreadableResult();
      if (printing !== null && printing.printing_id !== parsed.data.entry_id)
        throw unreadableResult();
      entries.push({
        entryKey: catalogEntryKey(target),
        target,
        card: {
          cardId: card.card_id,
          name: card.name,
          names,
          rulesText: card.rules_text,
          typeLine: card.type_line,
          colors: card.colors,
          colorIdentity: card.color_identity,
          manaValue: card.mana_value,
          matchedName: parsed.data.matched_name,
        },
        printing:
          printing === null
            ? null
            : {
                printingId: printing.printing_id,
                cardId: printing.card_id,
                edition: printing.edition,
                collectorNumber: printing.collector_number,
                language: printing.language,
                finishes: printing.finishes,
                physical: printing.physical,
                images: {
                  small: printing.image_small,
                  normal: printing.image_normal,
                  large: printing.image_large,
                  artCrop: printing.image_art_crop,
                },
              },
      });
      continue;
    }
    const parsed = stateRowSchema.safeParse(row);
    if (!parsed.success || state !== null) throw unreadableResult();
    state = {
      totalCount: parsed.data.total_count,
      revision: revisionFromJson(parseJsonText(revisionJsonSchema, parsed.data.revision)),
    };
  }
  if (state === null) throw unreadableResult();
  return { entries, ...state };
}

function unreadableResult(): CatalogError {
  return new CatalogError('unavailable', 'The catalog returned a result that is not readable.');
}

/** Evaluates current public membership from Catalog-owned storage in one revision-consistent read. */
export async function executeCatalogQuery(
  sql: CatalogSqlExecutor,
  request: CatalogQueryInput,
): Promise<CatalogQueryPage> {
  const query = normalizeCatalogQuery(request);
  const cursor =
    request.continuation === undefined || request.continuation === null
      ? null
      : readCursor(request.continuation);
  if (cursor !== null && cursor.fingerprint !== queryFingerprint(query)) {
    throw new CatalogError(
      'stale-continuation',
      'This continuation belongs to a different catalog query; start it again.',
    );
  }
  const offset = cursor?.offset ?? 0;
  const statement = pageStatement(query, offset, query.pageSize + 1);
  let rows: readonly CatalogSqlRow[];
  try {
    rows = await sql.query(statement.statement, statement.parameters);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog database could not be read.', { cause });
  }
  const page = readPage(rows, query.resultLevel);
  if (cursor !== null && cursor.revision !== page.revision.revisionId) {
    throw new CatalogError(
      'stale-continuation',
      'The catalog changed after this page was read; start the query again.',
    );
  }
  const hasMore = page.entries.length > query.pageSize;
  return {
    entries: hasMore ? page.entries.slice(0, query.pageSize) : page.entries,
    totalCount: page.totalCount,
    revision: page.revision,
    continuation: hasMore
      ? encodeCursor(query, page.revision.revisionId, offset + query.pageSize)
      : null,
  };
}
