import { CATALOG_QUERY_SURFACE } from '../../catalog/index.js';
import { USERCARDS_QUERY_SURFACE } from '../../usercards/index.js';

import type { SearchSqlValue } from './executor.js';
import {
  isPrivateCriterion,
  requiresTrustedContext,
  searchPublicCriterionLevel,
  type SearchColorCriterion,
  type SearchColorIdentityCriterion,
  type SearchComparison,
  type SearchCriterion,
  type SearchFilter,
  type SearchQuery,
  type SearchResultLevel,
} from './model.js';

/**
 * One page read over the published Catalog and UserCards relations
 * (docs/search.md#required-query-contracts, docs/search.md#evaluation-and-grouping).
 *
 * The statement joins only the declared views: the entry's card, its printing and, for private
 * criteria, the account-scoped copies and associations. Membership, the exact total count and the
 * revisions are read in one snapshot, and the ordering adds a stable identity tie-breaker, so the
 * page boundary never depends on an unstable order. A caller-supplied predicate never reaches the
 * database: the query model is the only input and every value travels as a named parameter.
 */

/** Relations of the two published surfaces, taken from the declarations instead of repeated text. */
const relations = {
  cards: CATALOG_QUERY_SURFACE.relations.cards.name,
  cardNames: CATALOG_QUERY_SURFACE.relations.cardNames.name,
  printings: CATALOG_QUERY_SURFACE.relations.printings.name,
  publishedRevision: CATALOG_QUERY_SURFACE.relations.publishedRevision.name,
  copies: USERCARDS_QUERY_SURFACE.relations.copies.name,
  associations: USERCARDS_QUERY_SURFACE.relations.associations.name,
  privateRevision: USERCARDS_QUERY_SURFACE.relations.privateRevision.name,
} as const;

export interface SearchPageStatement {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, SearchSqlValue>>;
}

/**
 * The evaluated scope of one criterion. Card criteria always read the entry's card. A printing or
 * private criterion reads the entry's own printing or copy when the entry represents one, and
 * otherwise a related printing of a card-level entry.
 */
interface SqlContext {
  readonly level: SearchResultLevel;
  readonly filters: readonly SearchFilter[];
  /** Whether the query reads the account's private data at all. */
  readonly privateRead: boolean;
  readonly card: string;
  readonly printing: string | null;
  readonly copy: string | null;
  readonly bind: (value: SearchSqlValue) => string;
  readonly alias: (prefix: string) => string;
}

/**
 * Reads the requested page of one normalized query. `limit` is the page size plus one, so the
 * caller can tell an exact page end from a following page without a second statement.
 */
export function pageStatement(
  query: SearchQuery,
  offset: number,
  limit: number,
): SearchPageStatement {
  const parameters: Record<string, SearchSqlValue> = {};
  let parameterCount = 0;
  let aliasCount = 0;
  const bind = (value: SearchSqlValue): string => {
    const name = `search_${parameterCount}`;
    parameterCount += 1;
    parameters[name] = value;
    return `:${name}`;
  };
  const alias = (prefix: string): string => {
    aliasCount += 1;
    return `${prefix}_${aliasCount}`;
  };

  const level = query.resultLevel;
  const context: SqlContext = {
    level,
    filters: query.filters,
    privateRead: requiresTrustedContext(query),
    card: 'card',
    printing: level === 'card' ? null : 'printing',
    copy: level === 'copy' ? 'copy' : null,
    bind,
    alias,
  };

  const from = fromSql(level);
  const where = filterSqls(context.filters, context);
  const entryId = entryIdSql(level);
  const printingColumns = printingColumnsSql(level);
  const orderBy =
    query.ordering.field === 'name'
      ? `lower(card_name) ${query.ordering.direction === 'descending' ? 'desc' : 'asc'}, entry_id asc`
      : `mana_value ${query.ordering.direction === 'descending' ? 'desc' : 'asc'} nulls last, entry_id asc`;
  const privateRevision = context.privateRead
    ? `(select revision from ${relations.privateRevision})`
    : 'null::text';

  const statement = `with matched as (
  select
    ${entryId} as entry_id,
    card.card_id as card_id,
    card.name as card_name,
    ${matchedNameSql(context)} as matched_name,
    ${printingColumns},
    card.mana_value as mana_value,
    ${copiesSql(context)} as copies,
    ${intendedSql(context)} as intended
  from ${from}
  where ${where}
),
page as (
  select * from matched
  order by ${orderBy}
  limit :page_limit offset :page_offset
)
select
  'entry' as row_kind,
  (row_number() over (order by ${orderBy}))::int as row_position,
  entry_id,
  card_id,
  card_name,
  matched_name,
  printing_id,
  edition,
  collector_number,
  language,
  copies,
  intended,
  null::text as catalog_revision,
  null::text as private_revision,
  null::int as total_count
from page
union all
select
  'revision' as row_kind,
  0 as row_position,
  null::text as entry_id,
  null::text as card_id,
  null::text as card_name,
  null::text as matched_name,
  null::text as printing_id,
  null::text as edition,
  null::text as collector_number,
  null::text as language,
  null::int as copies,
  null::int as intended,
  revision.revision_id::text as catalog_revision,
  ${privateRevision} as private_revision,
  (select count(*)::int from matched) as total_count
from ${relations.publishedRevision} as revision
order by row_kind desc, row_position`;

  parameters.page_limit = limit;
  parameters.page_offset = offset;
  return { statement, parameters };
}

/** The relations one result level reads. Private relations appear only for private queries. */
function fromSql(level: SearchResultLevel): string {
  switch (level) {
    case 'card':
      return `${relations.cards} as card`;
    case 'printing':
      return (
        `${relations.printings} as printing` +
        ` join ${relations.cards} as card on card.card_id = printing.card_id`
      );
    case 'copy':
      return (
        `${relations.copies} as copy` +
        ` join ${relations.printings} as printing on printing.printing_id = copy.printing_id` +
        ` join ${relations.cards} as card on card.card_id = printing.card_id`
      );
  }
}

function entryIdSql(level: SearchResultLevel): string {
  switch (level) {
    case 'card':
      return 'card.card_id';
    case 'printing':
      return 'printing.printing_id';
    case 'copy':
      return 'copy.copy_id';
  }
}

/** A card-level entry carries no printing; every other entry carries the printing it represents. */
function printingColumnsSql(level: SearchResultLevel): string {
  if (level === 'card') {
    return (
      'null::text as printing_id, null::text as edition,' +
      ' null::text as collector_number, null::text as language'
    );
  }
  return (
    'printing.printing_id as printing_id, printing.edition as edition,' +
    ' printing.collector_number as collector_number, printing.language as language'
  );
}

function filterSql(filter: SearchFilter, context: SqlContext): string {
  switch (filter.kind) {
    case 'criterion':
      return criterionSql(filter.criterion, context);
    case 'not':
      return `not (${filterSql(filter.operand, context)})`;
    case 'or':
      return `(${filter.operands.map((operand) => filterSql(operand, context)).join(' or ')})`;
    case 'and':
      return conjunctionSql(filter.operands, context);
  }
}

/**
 * One conjunction. When the entry is a card and the conjunction names related printing or private
 * criteria directly, those operands are bound to one related printing, so `set:` and ownership
 * cannot be satisfied by two different printings of the same card
 * (docs/search.md#evaluation-and-grouping). Groups and negations keep the entry-level meaning of
 * their own combination.
 */
function conjunctionSql(operands: readonly SearchFilter[], context: SqlContext): string {
  if (context.printing !== null || context.copy !== null) {
    return `(${operands.map((operand) => filterSql(operand, context)).join(' and ')})`;
  }
  const related: SearchCriterion[] = [];
  const rest: SearchFilter[] = [];
  for (const operand of operands) {
    if (operand.kind === 'criterion' && isRelatedCriterion(operand.criterion)) {
      related.push(operand.criterion);
    } else {
      rest.push(operand);
    }
  }
  const parts = rest.map((operand) => filterSql(operand, context));
  if (related.length > 0) {
    const printing = context.alias('related');
    const bound: SqlContext = { ...context, printing };
    const predicate = related.map((criterion) => criterionSql(criterion, bound)).join(' and ');
    parts.unshift(
      `exists (select 1 from ${relations.printings} as ${printing}` +
        ` where ${printing}.card_id = ${context.card}.card_id and ${predicate})`,
    );
  }
  return parts.length === 0 ? 'true' : `(${parts.join(' and ')})`;
}

/** Whether one criterion is evaluated against a related printing or copy rather than the card. */
function isRelatedCriterion(criterion: SearchCriterion): boolean {
  return isPrivateCriterion(criterion) || searchPublicCriterionLevel(criterion) === 'printing';
}

function criterionSql(criterion: SearchCriterion, context: SqlContext): string {
  switch (criterion.kind) {
    case 'name':
      return nameMatchSql(criterion.text, context);
    case 'rulesText':
      return textMatchSql(`${context.card}.rules_text`, criterion.text, context);
    case 'type':
      return textMatchSql(`${context.card}.type_line`, criterion.text, context);
    case 'color':
      return colorSql(`${context.card}.colors`, criterion);
    case 'colorIdentity':
      return colorSql(`${context.card}.color_identity`, criterion);
    case 'manaValue':
      return manaValueSql(criterion.comparison, criterion.value, context);
    case 'set':
      return printingSql(
        (printing) => `upper(${printing}.edition) = ${context.bind(criterion.edition)}`,
        context,
      );
    case 'language':
      return printingSql(
        (printing) => `lower(${printing}.language) = ${context.bind(criterion.language)}`,
        context,
      );
    case 'finish':
      return printingSql(
        (printing) => `${context.bind(criterion.finish)} = any(${printing}.finishes)`,
        context,
      );
    case 'owned':
      return ownedSql(context);
    case 'tag':
      return tagSql(criterion.tagId, context);
  }
}

/** Name matching covers the canonical name and every translated or face name of the identity. */
function nameMatchSql(text: string, context: SqlContext): string {
  const value = context.bind(text);
  const alias = context.alias('name_alias');
  return (
    `(strpos(lower(${context.card}.name), ${value}) > 0 or exists (` +
    `select 1 from ${relations.cardNames} as ${alias}` +
    ` where ${alias}.card_id = ${context.card}.card_id` +
    ` and strpos(lower(${alias}.name), ${value}) > 0))`
  );
}

function textMatchSql(column: string, text: string, context: SqlContext): string {
  return `strpos(lower(${column}), ${context.bind(text)}) > 0`;
}

/**
 * The name to display for a matched identity: null when the canonical name matched, otherwise the
 * first translated or face name that matched, in a deterministic order
 * (docs/search.md#evaluation-and-grouping).
 */
function matchedNameSql(context: SqlContext): string {
  const texts = positiveNameTexts(context.filters);
  if (texts.length === 0) {
    return 'null::text';
  }
  const canonical = texts
    .map((text) => `strpos(lower(${context.card}.name), ${context.bind(text)}) > 0`)
    .join(' or ');
  const alias = context.alias('display_name');
  const translated = texts
    .map((text) => `strpos(lower(${alias}.name), ${context.bind(text)}) > 0`)
    .join(' or ');
  return (
    `case when ${canonical} then null::text else (` +
    `select ${alias}.name from ${relations.cardNames} as ${alias}` +
    ` where ${alias}.card_id = ${context.card}.card_id and (${translated})` +
    ` order by ${alias}.language, ${alias}.name, ${alias}.card_id limit 1) end`
  );
}

/** Wraps one printing-scoped predicate: the entry's printing, or any printing of a card entry. */
function printingSql(predicate: (printing: string) => string, context: SqlContext): string {
  if (context.printing !== null) {
    return predicate(context.printing);
  }
  const related = context.alias('related');
  return (
    `exists (select 1 from ${relations.printings} as ${related}` +
    ` where ${related}.card_id = ${context.card}.card_id and ${predicate(related)})`
  );
}

/**
 * Ownership: the entry's own copy is owned, or one of the related printing's copies is. A card- or
 * printing-level entry represents the account's copies of that identity, so any owned copy makes
 * it owned.
 */
function ownedSql(context: SqlContext): string {
  if (context.copy !== null) {
    return `${context.copy}.owned`;
  }
  return printingSql(
    (printing) =>
      `exists (select 1 from ${relations.copies} as owned_copy` +
      ` where owned_copy.printing_id = ${printing}.printing_id and owned_copy.owned)`,
    context,
  );
}

/**
 * Tag membership of the identity the entry represents
 * (docs/search.md#evaluation-and-grouping, docs/architecture.md#tags-and-associations). A copy
 * entry is a member only when the tag associates that copy. A printing entry is a member when the
 * tag associates the printing or one of its copies. A card entry is also a member when the tag
 * associates the card itself: the card-level association is broader than any of its printings.
 */
function tagSql(tagId: string, context: SqlContext): string {
  const tag = context.bind(tagId);
  if (context.copy !== null) {
    return (
      `exists (select 1 from ${relations.associations} as copy_tag` +
      ` where copy_tag.tag_id = ${tag} and copy_tag.target_level = 'copy'` +
      ` and copy_tag.target_id = ${context.copy}.copy_id)`
    );
  }
  return printingSql((printing) => {
    const association = context.alias('tag_association');
    const member = context.alias('tag_copy');
    const levels = [
      `(${association}.target_level = 'printing'` +
        ` and ${association}.target_id = ${printing}.printing_id)`,
      `(${association}.target_level = 'copy' and exists (` +
        `select 1 from ${relations.copies} as ${member}` +
        ` where ${member}.copy_id = ${association}.target_id` +
        ` and ${member}.printing_id = ${printing}.printing_id))`,
    ];
    if (context.level === 'card') {
      levels.push(
        `(${association}.target_level = 'card'` +
          ` and ${association}.target_id = ${context.card}.card_id)`,
      );
    }
    return (
      `exists (select 1 from ${relations.associations} as ${association}` +
      ` where ${association}.tag_id = ${tag} and (${levels.join(' or ')}))`
    );
  }, context);
}

/**
 * Set comparison of card colors or color identity. Color letters are validated criterion values, so
 * they inline as an array literal; the deployed executor never receives array parameters.
 */
function colorSql(
  column: string,
  criterion: SearchColorCriterion | SearchColorIdentityCriterion,
): string {
  const selected = `array[${criterion.colors.map((color) => `'${color}'`).join(', ')}]::text[]`;
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

/** A published mana value that the provider does not give satisfies no comparison. */
function manaValueSql(comparison: SearchComparison, value: number, context: SqlContext): string {
  const operator = comparison === '!=' ? '<>' : comparison;
  return (
    `(${context.card}.mana_value is not null` +
    ` and ${context.card}.mana_value ${operator} ${context.bind(value)})`
  );
}

/**
 * Copies the entry represents, exact and grouped by identity. A copy entry represents exactly one
 * copy; a printing or card entry counts the account's distinct copies of that printing or card that
 * satisfy the query, so two matching tags or printings never multiply one copy. A public query
 * reads no private data and carries no count.
 */
function copiesSql(context: SqlContext): string {
  if (!context.privateRead) {
    return 'null::int';
  }
  if (context.copy !== null) {
    return '1';
  }
  if (context.level === 'printing' && context.printing !== null) {
    const copy = context.alias('entry_copy');
    const predicate = filterSqls(context.filters, { ...context, copy });
    return (
      `(select count(*)::int from ${relations.copies} as ${copy}` +
      ` where ${copy}.printing_id = ${context.printing}.printing_id and ${predicate})`
    );
  }
  const copy = context.alias('entry_copy');
  const printing = context.alias('entry_printing');
  const predicate = filterSqls(context.filters, { ...context, printing, copy });
  return (
    `(select count(*)::int from ${relations.copies} as ${copy}` +
    ` join ${relations.printings} as ${printing} on ${printing}.printing_id = ${copy}.printing_id` +
    ` where ${printing}.card_id = ${context.card}.card_id` +
    ` and ${predicate})`
  );
}

/**
 * Intended or required quantity of the tags the query names positively. Card- and printing-level
 * associations of an entry's card or printing add up; copy membership carries no intent, so an
 * entry that only carries copy membership has no intended quantity.
 */
function intendedSql(context: SqlContext): string {
  const tags = positiveTagIds(context.filters);
  if (tags.length === 0) {
    return 'null::int';
  }
  const association = context.alias('intent');
  const tagList = tags.map((tagId) => context.bind(tagId)).join(', ');
  return (
    `(select sum(${association}.quantity)::int from ${relations.associations} as ${association}` +
    ` where ${association}.tag_id in (${tagList}) and ${association}.quantity is not null` +
    ` and ${associationCoversSql(association, context)})`
  );
}

function associationCoversSql(association: string, context: SqlContext): string {
  const printing = context.printing;
  if (context.level === 'card' || printing === null) {
    const intentPrinting = context.alias('intent_printing');
    return (
      `((${association}.target_level = 'card' and ${association}.target_id = ${context.card}.card_id)` +
      ` or (${association}.target_level = 'printing' and exists (` +
      `select 1 from ${relations.printings} as ${intentPrinting}` +
      ` where ${intentPrinting}.printing_id = ${association}.target_id` +
      ` and ${intentPrinting}.card_id = ${context.card}.card_id)))`
    );
  }
  return (
    `((${association}.target_level = 'printing'` +
    ` and ${association}.target_id = ${printing}.printing_id)` +
    ` or (${association}.target_level = 'card'` +
    ` and ${association}.target_id = ${context.card}.card_id))`
  );
}

function filterSqls(filters: readonly SearchFilter[], context: SqlContext): string {
  return filters.length === 0 ? 'true' : conjunctionSql(filters, context);
}

/** Criteria that the filter names outside every negation; a negated value has no display meaning. */
function positiveCriteria(filters: readonly SearchFilter[]): readonly SearchCriterion[] {
  const found: SearchCriterion[] = [];
  const visit = (filter: SearchFilter): void => {
    switch (filter.kind) {
      case 'criterion':
        found.push(filter.criterion);
        return;
      case 'and':
      case 'or':
        filter.operands.forEach(visit);
        return;
      case 'not':
        return;
    }
  };
  filters.forEach(visit);
  return found;
}

function positiveNameTexts(filters: readonly SearchFilter[]): readonly string[] {
  return positiveCriteria(filters).flatMap((criterion) =>
    criterion.kind === 'name' ? [criterion.text] : [],
  );
}

function positiveTagIds(filters: readonly SearchFilter[]): readonly string[] {
  const tags = positiveCriteria(filters).flatMap((criterion) =>
    criterion.kind === 'tag' ? [criterion.tagId] : [],
  );
  return [...new Set(tags)];
}
