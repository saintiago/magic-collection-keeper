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
import type { SearchCountReference } from './results.js';

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
 * One private count read over the published surfaces
 * (docs/search.md#request-and-result, docs/search.md#evaluation-and-grouping).
 *
 * Every requested reference is answered exactly: the account's owned copies of it, the distinct
 * physical locations holding those copies, and the intended quantity one tag associates with it
 * under the same covering rule the query evaluation uses. The read takes explicit references, so a
 * caller enriches the entries it presents without changing the query that selected them; the
 * account scope of the statement's execution decides whose copies and associations are counted.
 * The statement also reports the private revision it read, and every value travels as a named
 * parameter.
 */
export function countsStatement(
  references: readonly SearchCountReference[],
  tagId: string | null,
): SearchPageStatement {
  const parameters: Record<string, SearchSqlValue> = {};
  let parameterCount = 0;
  const bind = (value: SearchSqlValue): string => {
    const name = `search_count_${parameterCount}`;
    parameterCount += 1;
    parameters[name] = value;
    return `:${name}`;
  };
  const tag = tagId === null ? null : bind(tagId);

  const rows = references.map((reference) => {
    switch (reference.kind) {
      case 'card':
        return countRowSql('card', bind(reference.cardId), tag);
      case 'printing':
        return countRowSql('printing', bind(reference.printingId), tag);
      case 'copy':
        return countRowSql('copy', bind(reference.copyId), tag);
    }
  });

  const statement = `with counted as (
${rows.join('\nunion all\n')}
)
select
  'count' as row_kind,
  ref_kind,
  ref_id,
  owned,
  locations,
  intended,
  null::text as private_revision
from counted
union all
select
  'revision' as row_kind,
  null::text as ref_kind,
  null::text as ref_id,
  null::int as owned,
  null::int as locations,
  null::int as intended,
  (select revision from ${relations.privateRevision}) as private_revision`;
  return { statement, parameters };
}

/**
 * One reference's counts: owned copies of the card, printing or copy the reference names, the
 * distinct locations holding them, and the named tag's intended quantity covering the reference.
 */
function countRowSql(
  kind: SearchCountReference['kind'],
  reference: string,
  tag: string | null,
): string {
  const copyMatch =
    kind === 'card'
      ? `printing.card_id = ${reference}`
      : kind === 'printing'
        ? `copy.printing_id = ${reference}`
        : `copy.copy_id = ${reference}`;
  const joinPrintings =
    kind === 'copy'
      ? ''
      : ` join ${relations.printings} as printing on printing.printing_id = copy.printing_id`;
  const card =
    kind === 'card'
      ? reference
      : kind === 'printing'
        ? printingCardSql('intent_printing', reference)
        : copyCardSql('intent_copy', reference);
  const printing =
    kind === 'card'
      ? null
      : kind === 'printing'
        ? reference
        : `(select intent_copy.printing_id from ${relations.copies} as intent_copy` +
          ` where intent_copy.copy_id = ${reference})`;
  return (
    `select '${kind}' as ref_kind, ${reference} as ref_id,\n` +
    `  (select count(*)::int from ${relations.copies} as copy${joinPrintings}` +
    ` where copy.owned and ${copyMatch}) as owned,\n` +
    `  (select count(distinct copy.location_id)::int from ${relations.copies} as copy${joinPrintings}` +
    ` where copy.owned and copy.location_id is not null and ${copyMatch}) as locations,\n` +
    `  ${intentRowSql(card, printing, tag)} as intended`
  );
}

/**
 * The intended quantity one tag associates with the reference, under the covering rule the query
 * evaluation uses: a card association covers its card and every printing of it, a printing
 * association covers that printing and the copies of it, and a copy reference is covered through
 * its own printing. No association summing to nothing reports null, never zero.
 */
function intentRowSql(card: string, printing: string | null, tag: string | null): string {
  if (tag === null) {
    return 'null::int';
  }
  const coversCard =
    printing === null
      ? `(association.target_level = 'printing' and exists (` +
        `select 1 from ${relations.printings} as intent_printing` +
        ` where intent_printing.printing_id = association.target_id` +
        ` and intent_printing.card_id = ${card}))`
      : `(association.target_level = 'printing' and association.target_id = ${printing})`;
  return (
    `(select sum(association.quantity)::int from ${relations.associations} as association` +
    ` where association.tag_id = ${tag} and association.quantity is not null` +
    ` and ((association.target_level = 'card' and association.target_id = ${card})` +
    ` or ${coversCard}))`
  );
}

/** The card a copy reference belongs to, read through its printing. */
function copyCardSql(alias: string, copyId: string): string {
  const printing = `${alias}_printing`;
  return (
    `(select ${printing}.card_id from ${relations.copies} as ${alias}` +
    ` join ${relations.printings} as ${printing}` +
    ` on ${printing}.printing_id = ${alias}.printing_id` +
    ` where ${alias}.copy_id = ${copyId})`
  );
}

/** The card a printing reference belongs to. */
function printingCardSql(alias: string, printingId: string): string {
  return (
    `(select ${alias}.card_id from ${relations.printings} as ${alias}` +
    ` where ${alias}.printing_id = ${printingId})`
  );
}

/**
 * The evaluated scope of one entry. Card criteria always read the entry's card. A printing or
 * private criterion reads a related printing or copy: the entry's own when it represents one, and
 * otherwise one of the card's printings, chosen once for the whole query
 * (docs/search.md#evaluation-and-grouping).
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

/**
 * Membership of the entry a context describes (docs/search.md#scryfall-compatibility,
 * docs/search.md#evaluation-and-grouping).
 *
 * The whole query is evaluated against one related printing and one related copy of the entry:
 * printing criteria read that printing, private criteria read its copies, and card criteria read
 * the entry's card. A criterion that needs a related row the evaluated binding has none of is
 * unknown, so the entry is a member only when some related printing and copy satisfies the query —
 * including the entry without any related row, so membership the account attached to the card
 * itself matches a card the catalog publishes without printings. Two criteria of one query never
 * match through two different printings or copies.
 */
function filterSqls(filters: readonly SearchFilter[], context: SqlContext): string {
  if (filters.length === 0) {
    return 'true';
  }
  if (context.copy !== null) {
    // A copy entry is its own related row: nothing else can satisfy one of its criteria.
    return boundFiltersSql(filters, context, { printing: context.printing, copy: context.copy });
  }
  if (context.printing !== null) {
    // A printing entry is its own related printing; a private criterion reads one of its copies.
    return relatedPrintingSql(filters, context, context.printing);
  }
  const parts = [boundFiltersSql(filters, context, { printing: null, copy: null })];
  if (relatedRowsRead(filters, context).printing) {
    const printing = context.alias('related');
    parts.push(
      `exists (select 1 from ${relations.printings} as ${printing}` +
        ` where ${printing}.card_id = ${context.card}.card_id` +
        ` and ${relatedPrintingSql(filters, context, printing)})`,
    );
  }
  return `(${parts.join(' or ')})`;
}

/**
 * The same membership against one chosen related printing: the entry's own, or one printing of a
 * card entry. A private criterion reads one of that printing's copies, so two private criteria
 * share their copy instead of matching one copy each.
 */
function relatedPrintingSql(
  filters: readonly SearchFilter[],
  context: SqlContext,
  printing: string,
): string {
  const parts = [boundFiltersSql(filters, context, { printing, copy: null })];
  if (relatedRowsRead(filters, context).copy) {
    const copy = context.alias('related_copy');
    parts.push(
      `exists (select 1 from ${relations.copies} as ${copy}` +
        ` where ${copy}.printing_id = ${printing}.printing_id` +
        ` and ${boundFiltersSql(filters, context, { printing, copy })})`,
    );
  }
  return `(${parts.join(' or ')})`;
}

/**
 * The related rows a query reads: a printing criterion reads a related printing, a private
 * criterion reads the account's copies of one, and a copy belongs to a printing. Card criteria
 * read no related row at all.
 */
function relatedRowsRead(
  filters: readonly SearchFilter[],
  context: SqlContext,
): { readonly printing: boolean; readonly copy: boolean } {
  let printing = false;
  let copy = false;
  const visit = (filter: SearchFilter): void => {
    switch (filter.kind) {
      case 'criterion':
        if (isPrivateCriterion(filter.criterion)) {
          copy = true;
          return;
        }
        printing = printing || searchPublicCriterionLevel(filter.criterion) === 'printing';
        return;
      case 'and':
      case 'or':
        filter.operands.forEach(visit);
        return;
      case 'not':
        visit(filter.operand);
        return;
    }
  };
  filters.forEach(visit);
  // A copy belongs to a printing, so a card entry reaches the account's copies through one of its
  // printings even though a copy criterion is the only thing that reads the copy itself.
  return { printing: printing || (copy && context.printing === null), copy };
}

/**
 * One related-printing and related-copy binding: the criteria are evaluated against exactly these
 * rows, and a criterion that needs a row this binding has none of is unknown rather than false.
 */
interface RelatedBinding {
  readonly printing: string | null;
  readonly copy: string | null;
}

function boundFiltersSql(
  filters: readonly SearchFilter[],
  context: SqlContext,
  binding: RelatedBinding,
): string {
  return `(${filters.map((filter) => boundFilterSql(filter, context, binding)).join(' and ')})`;
}

/**
 * One filter under one related-row binding: every criterion keeps its meaning, including a
 * negation, which is evaluated against the same related printing and copy as the criteria it is
 * combined with.
 */
function boundFilterSql(
  filter: SearchFilter,
  context: SqlContext,
  binding: RelatedBinding,
): string {
  switch (filter.kind) {
    case 'criterion':
      return criterionSql(filter.criterion, context, binding);
    case 'not':
      return `not (${boundFilterSql(filter.operand, context, binding)})`;
    case 'or':
      return `(${filter.operands
        .map((operand) => boundFilterSql(operand, context, binding))
        .join(' or ')})`;
    case 'and':
      return boundFiltersSql(filter.operands, context, binding);
  }
}

/** A criterion that needs a related row this binding has none of is unknown, not false. */
const unknownMatch = 'null::boolean';

function criterionSql(
  criterion: SearchCriterion,
  context: SqlContext,
  binding: RelatedBinding,
): string {
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
      return printingMatchSql(
        binding,
        (printing) => `upper(${printing}.edition) = ${context.bind(criterion.edition)}`,
      );
    case 'language':
      return printingMatchSql(
        binding,
        (printing) => `lower(${printing}.language) = ${context.bind(criterion.language)}`,
      );
    case 'finish':
      return printingMatchSql(
        binding,
        (printing) => `${context.bind(criterion.finish)} = any(${printing}.finishes)`,
      );
    case 'owned':
      return binding.copy === null ? unknownMatch : `${binding.copy}.owned`;
    case 'tag':
      return tagSql(criterion.tagId, context, binding);
  }
}

/** One printing predicate, or unknown when this scope carries no related printing. */
function printingMatchSql(
  binding: RelatedBinding,
  predicate: (printing: string) => string,
): string {
  return binding.printing === null ? unknownMatch : predicate(binding.printing);
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

/**
 * Text containment. The published contract permits an absent attribute, and an absent attribute
 * does not contain the text: the criterion is false rather than unknown, so a negation of it stays
 * satisfiable (docs/search.md#scryfall-compatibility).
 */
function textMatchSql(column: string, text: string, context: SqlContext): string {
  return `strpos(lower(coalesce(${column}, '')), ${context.bind(text)}) > 0`;
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

/**
 * Tag membership of the identity the entry represents
 * (docs/search.md#evaluation-and-grouping, docs/architecture.md#tags-and-associations). A copy
 * entry is a member only when the tag associates that copy. A printing entry is a member when the
 * tag associates the scope's related printing or one of its copies. A card entry is also a member
 * when the tag associates the card itself: the card-level association is broader than any of its
 * printings and needs no printing at all. A level this scope carries no related row for is
 * unknown, so two tag criteria never match through two different copies.
 */
function tagSql(tagId: string, context: SqlContext, binding: RelatedBinding): string {
  const tag = context.bind(tagId);
  const alternatives: string[] = [];
  if (context.level === 'card') {
    alternatives.push(associationSql(context, tag, 'card', `${context.card}.card_id`));
  }
  if (context.level !== 'copy' && binding.printing !== null) {
    alternatives.push(associationSql(context, tag, 'printing', `${binding.printing}.printing_id`));
  }
  if (binding.copy !== null) {
    alternatives.push(associationSql(context, tag, 'copy', `${binding.copy}.copy_id`));
  }
  if (context.level !== 'copy' && (binding.printing === null || binding.copy === null)) {
    alternatives.push(unknownMatch);
  }
  return `(${alternatives.join(' or ')})`;
}

/** Membership of one identity in one tag, at one association level. */
function associationSql(
  context: SqlContext,
  tag: string,
  level: 'card' | 'printing' | 'copy',
  target: string,
): string {
  const association = context.alias('association');
  return (
    `exists (select 1 from ${relations.associations} as ${association}` +
    ` where ${association}.tag_id = ${tag} and ${association}.target_level = '${level}'` +
    ` and ${association}.target_id = ${target})`
  );
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
 * satisfy the query as copy-level entries, so the grouped count agrees with the copies a copy-level
 * search returns and two matching tags or printings never multiply one copy
 * (docs/search.md#evaluation-and-grouping). A public query reads no private data and carries no
 * count.
 */
function copiesSql(context: SqlContext): string {
  if (!context.privateRead) {
    return 'null::int';
  }
  if (context.copy !== null) {
    return '1';
  }
  const copy = context.alias('entry_copy');
  if (context.printing !== null) {
    const copyContext: SqlContext = { ...context, level: 'copy', copy };
    const predicate = filterSqls(context.filters, copyContext);
    return (
      `(select count(*)::int from ${relations.copies} as ${copy}` +
      ` where ${copy}.printing_id = ${context.printing}.printing_id and ${predicate})`
    );
  }
  const printing = context.alias('entry_printing');
  const copyContext: SqlContext = { ...context, level: 'copy', printing, copy };
  const predicate = filterSqls(context.filters, copyContext);
  return (
    `(select count(*)::int from ${relations.copies} as ${copy}` +
    ` join ${relations.printings} as ${printing} on ${printing}.printing_id = ${copy}.printing_id` +
    ` where ${printing}.card_id = ${context.card}.card_id` +
    ` and ${predicate})`
  );
}

/**
 * Intended or required quantity of the tags the query names positively
 * (docs/search.md#evaluation-and-grouping). A card association covers its card; a printing
 * association covers one of the entry's printings only when that printing satisfies the query, so
 * a filtered search never adds up intentions of printings it excluded. Copy membership carries no
 * intent, so an entry that only carries copy membership has no intended quantity.
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
  if (context.printing !== null) {
    return (
      `((${association}.target_level = 'printing'` +
      ` and ${association}.target_id = ${context.printing}.printing_id)` +
      ` or (${association}.target_level = 'card'` +
      ` and ${association}.target_id = ${context.card}.card_id))`
    );
  }
  const intentPrinting = context.alias('intent_printing');
  return (
    `((${association}.target_level = 'card'` +
    ` and ${association}.target_id = ${context.card}.card_id)` +
    ` or (${association}.target_level = 'printing' and exists (` +
    `select 1 from ${relations.printings} as ${intentPrinting}` +
    ` where ${intentPrinting}.printing_id = ${association}.target_id` +
    ` and ${intentPrinting}.card_id = ${context.card}.card_id` +
    ` and ${relatedPrintingSql(context.filters, context, intentPrinting)})))`
  );
}

/**
 * Criteria the filter carries with a positive polarity: a negated value has no display meaning,
 * but a value under an even number of negations still is the one that matched the entry. Counting
 * the effective polarity keeps the metadata of an equivalent expression identical
 * (docs/search.md#evaluation-and-grouping).
 */
function positiveCriteria(filters: readonly SearchFilter[]): readonly SearchCriterion[] {
  const found: SearchCriterion[] = [];
  const visit = (filter: SearchFilter, negated: boolean): void => {
    switch (filter.kind) {
      case 'criterion':
        if (!negated) {
          found.push(filter.criterion);
        }
        return;
      case 'and':
      case 'or':
        filter.operands.forEach((operand) => visit(operand, negated));
        return;
      case 'not':
        visit(filter.operand, !negated);
    }
  };
  filters.forEach((filter) => visit(filter, false));
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
