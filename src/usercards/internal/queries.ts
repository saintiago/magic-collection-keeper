import { createHash } from 'node:crypto';

import { z } from 'zod';

import { finishes } from '../../catalog/index.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import type { UserCardsSqlExecutor, UserCardsSqlValue } from './executor.js';
import { copyConditions, type TrustedUserContext } from './model.js';
import {
  USERCARDS_QUERY_LIMITS,
  userCardsOrderingFields,
  userCardsReferenceKey,
  userCardsResultLevels,
  userCardsSortDirections,
  type ReadUserCardsFragmentsInput,
  type UserCardsFragment,
  type UserCardsFragmentsResult,
  type UserCardsPhysicalDetail,
  type UserCardsQuery,
  type UserCardsQueryCriterion,
  type UserCardsQueryEntry,
  type UserCardsQueryInput,
  type UserCardsQueryPage,
  type UserCardsReference,
  type UserCardsResultLevel,
} from './query-model.js';
import {
  associationJsonSchema,
  associationsFromRows,
  copyFromRow,
  copyJsonSchema,
} from './rows.js';
import { groupRows, parsePayload, readRows, revisionFromPayload } from './sql.js';

const identifier = z.string().min(1).max(200);
const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card'), cardId: identifier }).strict(),
  z.object({ kind: z.literal('printing'), printingId: identifier }).strict(),
  z.object({ kind: z.literal('copy'), copyId: identifier }).strict(),
]);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('collection') }).strict(),
  z.object({ kind: z.literal('tag'), tagId: identifier }).strict(),
]);
const criterionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owned'), value: z.boolean() }).strict(),
  z.object({ kind: z.literal('tag'), tagId: identifier }).strict(),
  z.object({ kind: z.literal('location'), tagId: identifier }).strict(),
  z.object({ kind: z.literal('finish'), finish: z.enum(finishes) }).strict(),
  z.object({ kind: z.literal('condition'), condition: z.enum(copyConditions).nullable() }).strict(),
  z
    .object({
      kind: z.literal('identity'),
      references: z.array(referenceSchema).min(1).max(USERCARDS_QUERY_LIMITS.maxIdentityReferences),
    })
    .strict(),
]);
const querySchema = z
  .object({
    scope: scopeSchema,
    resultLevel: z.enum(userCardsResultLevels),
    criteria: z.array(criterionSchema).max(USERCARDS_QUERY_LIMITS.maxCriteria).optional(),
    ordering: z
      .object({
        field: z.enum(userCardsOrderingFields),
        direction: z.enum(userCardsSortDirections),
      })
      .strict()
      .optional(),
    pageSize: z
      .number()
      .int()
      .min(USERCARDS_QUERY_LIMITS.minPageSize)
      .max(USERCARDS_QUERY_LIMITS.maxPageSize)
      .optional(),
    continuation: z.string().min(1).max(USERCARDS_QUERY_LIMITS.maxContinuationLength).optional(),
  })
  .strict();

const fragmentRequestSchema = z
  .object({
    references: z.array(referenceSchema).max(USERCARDS_QUERY_LIMITS.maxFragmentReferences),
    tagId: identifier.optional(),
  })
  .strict();

export function normalizeUserCardsQuery(input: UserCardsQueryInput): UserCardsQuery {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) {
    throw new UserCardsError(
      'invalid-request',
      'A private query needs a supported scope, result level, private criteria, ordering and page size.',
    );
  }
  return {
    scope: parsed.data.scope,
    resultLevel: parsed.data.resultLevel,
    criteria: parsed.data.criteria ?? [],
    ordering: parsed.data.ordering ?? { field: 'identity', direction: 'ascending' },
    pageSize: parsed.data.pageSize ?? USERCARDS_QUERY_LIMITS.defaultPageSize,
  };
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
  revision: z.string().regex(/^[0-9]+$/),
  offset: z.number().int().min(0),
});

function criterionKey(criterion: UserCardsQueryCriterion): string {
  if (criterion.kind === 'identity') {
    return `identity:${[...new Set(criterion.references.map(userCardsReferenceKey))].sort().join(',')}`;
  }
  if (criterion.kind === 'owned') return `owned:${criterion.value}`;
  if (criterion.kind === 'finish') return `finish:${criterion.finish}`;
  if (criterion.kind === 'condition') return `condition:${criterion.condition ?? 'unknown'}`;
  return `${criterion.kind}:${criterion.tagId}`;
}

function queryFingerprint(accountId: string, query: UserCardsQuery): string {
  const encoded = JSON.stringify({
    version: 1,
    accountId,
    scope: query.scope,
    resultLevel: query.resultLevel,
    criteria: query.criteria.map(criterionKey).sort(),
    ordering: query.ordering,
    pageSize: query.pageSize,
  });
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

function readCursor(token: string): Cursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw staleContinuation();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) throw staleContinuation();
  return parsed.data;
}

function staleContinuation(): UserCardsError {
  return new UserCardsError(
    'stale-continuation',
    'The private data or request changed after this page was read; start the query again.',
  );
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

interface SqlBuilder {
  readonly parameters: Record<string, UserCardsSqlValue>;
  bind(value: UserCardsSqlValue): string;
}

function builder(accountId: string): SqlBuilder {
  let count = 0;
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  return {
    parameters,
    bind(value) {
      const name = `private_query_${count++}`;
      parameters[name] = value;
      return `:${name}`;
    },
  };
}

function copyMatches(level: UserCardsResultLevel, target = 'entry.target_id'): string {
  if (level === 'copy') return `copy.copy_id = ${target}`;
  if (level === 'printing') return `copy.printing_id = ${target}`;
  return `copy_reference.card_id = ${target}`;
}

function associationMatches(
  level: UserCardsResultLevel,
  target = 'entry.target_id',
  association = 'candidate',
): string {
  if (level === 'copy') {
    return `${association}.target_level = 'copy' and ${association}.target_id = ${target}`;
  }
  if (level === 'printing') {
    return `((${association}.target_level = 'printing' and ${association}.target_id = ${target})
      or (${association}.target_level = 'copy' and exists (
        select 1 from usercards_private.copy as associated_copy
         where associated_copy.account_id = ${association}.account_id
           and associated_copy.copy_id = ${association}.target_id
           and associated_copy.printing_id = ${target})))`;
  }
  return `((${association}.target_level = 'card' and ${association}.target_id = ${target})
    or (${association}.target_level = 'printing' and exists (
      select 1 from usercards_private.printing_reference as associated_reference
       where associated_reference.printing_id = ${association}.target_id
         and associated_reference.card_id = ${target}))
    or (${association}.target_level = 'copy' and exists (
      select 1
        from usercards_private.copy as associated_copy
        join usercards_private.printing_reference as associated_reference
          on associated_reference.printing_id = associated_copy.printing_id
       where associated_copy.account_id = ${association}.account_id
         and associated_copy.copy_id = ${association}.target_id
         and associated_reference.card_id = ${target})))`;
}

function identityCriterionSql(
  level: UserCardsResultLevel,
  references: readonly UserCardsReference[],
  sql: SqlBuilder,
): string {
  const conditions = references.map((reference) => {
    if (level === 'card') {
      if (reference.kind === 'card') {
        return `entry.target_id = ${sql.bind(reference.cardId)}`;
      }
      if (reference.kind === 'printing') {
        return `exists (select 1 from usercards_private.printing_reference as selected_reference
          where selected_reference.printing_id = ${sql.bind(reference.printingId)}
            and selected_reference.card_id = entry.target_id)`;
      }
      return `exists (select 1 from usercards_private.copy as selected_copy
        join usercards_private.printing_reference as selected_reference
          on selected_reference.printing_id = selected_copy.printing_id
       where selected_copy.account_id = :account_id
         and selected_copy.copy_id = ${sql.bind(reference.copyId)}
         and selected_reference.card_id = entry.target_id)`;
    }
    if (level === 'printing') {
      if (reference.kind === 'printing') {
        return `entry.target_id = ${sql.bind(reference.printingId)}`;
      }
      if (reference.kind === 'card') {
        return `exists (select 1 from usercards_private.printing_reference as selected_reference
          where selected_reference.printing_id = entry.target_id
            and selected_reference.card_id = ${sql.bind(reference.cardId)})`;
      }
      return `exists (select 1 from usercards_private.copy as selected_copy
        where selected_copy.account_id = :account_id
          and selected_copy.copy_id = ${sql.bind(reference.copyId)}
          and selected_copy.printing_id = entry.target_id)`;
    }
    if (reference.kind === 'copy') {
      return `entry.target_id = ${sql.bind(reference.copyId)}`;
    }
    if (reference.kind === 'printing') {
      return `exists (select 1 from usercards_private.copy as selected_copy
        where selected_copy.account_id = :account_id
          and selected_copy.copy_id = entry.target_id
          and selected_copy.printing_id = ${sql.bind(reference.printingId)})`;
    }
    return `exists (select 1 from usercards_private.copy as selected_copy
      join usercards_private.printing_reference as selected_reference
        on selected_reference.printing_id = selected_copy.printing_id
     where selected_copy.account_id = :account_id
       and selected_copy.copy_id = entry.target_id
       and selected_reference.card_id = ${sql.bind(reference.cardId)})`;
  });
  return `(${conditions.join(' or ')})`;
}

function queryStatement(
  accountId: string,
  query: UserCardsQuery,
  offset: number,
): {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, UserCardsSqlValue>>;
} {
  const sql = builder(accountId);
  const requiredTagIds = [
    ...(query.scope.kind === 'tag' ? [query.scope.tagId] : []),
    ...query.criteria.flatMap((criterion) =>
      criterion.kind === 'tag' || criterion.kind === 'location' ? [criterion.tagId] : [],
    ),
  ].filter((tagId, index, values) => values.indexOf(tagId) === index);
  const requiredTags = requiredTagIds.map((tagId) => sql.bind(tagId));
  const scope =
    query.scope.kind === 'collection'
      ? `select 'copy'::text as member_level, owned.association_id,
          reference.card_id, copy.printing_id, copy.copy_id, null::integer as quantity
         from usercards_private.copy as copy
         join usercards_private.printing_reference as reference
           on reference.printing_id = copy.printing_id
         join usercards_private.association as owned
           on owned.account_id = copy.account_id and owned.target_level = 'copy'
          and owned.tag_kind = 'owned' and owned.target_id = copy.copy_id
        where copy.account_id = :account_id`
      : `select association.target_level as member_level, association.association_id,
          case association.target_level
            when 'card' then association.target_id
            when 'printing' then reference.card_id
            else reference.card_id end as card_id,
          case association.target_level
            when 'printing' then association.target_id
            when 'copy' then copy.printing_id else null end as printing_id,
          case association.target_level when 'copy' then association.target_id else null end as copy_id,
          association.quantity
         from usercards_private.association as association
         left join usercards_private.copy as copy
           on association.target_level = 'copy' and copy.account_id = association.account_id
          and copy.copy_id = association.target_id
         left join usercards_private.printing_reference as reference
           on reference.printing_id = case association.target_level
             when 'printing' then association.target_id when 'copy' then copy.printing_id else null end
        where association.account_id = :account_id
          and association.tag_id = ${sql.bind(query.scope.tagId)}`;
  const target =
    query.resultLevel === 'card'
      ? 'member.card_id'
      : query.resultLevel === 'printing'
        ? 'member.printing_id'
        : 'member.copy_id';

  const conditions: string[] = [];
  const copyCriteria: string[] = [];
  for (const criterion of query.criteria) {
    switch (criterion.kind) {
      case 'owned':
        conditions.push(`entry.owned_copy_count ${criterion.value ? '>' : '='} 0`);
        break;
      case 'tag':
        conditions.push(`exists (select 1 from usercards_private.association as candidate
          where candidate.account_id = :account_id
            and candidate.tag_id = ${sql.bind(criterion.tagId)}
            and ${associationMatches(query.resultLevel)})`);
        break;
      case 'location':
        copyCriteria.push(`exists (select 1 from usercards_private.association as location_match
          where location_match.account_id = copy.account_id
            and location_match.target_level = 'copy'
            and location_match.tag_kind = 'location'
            and location_match.target_id = copy.copy_id
            and location_match.tag_id = ${sql.bind(criterion.tagId)})`);
        break;
      case 'finish':
        copyCriteria.push(`copy.finish = ${sql.bind(criterion.finish)}`);
        break;
      case 'condition':
        copyCriteria.push(
          criterion.condition === null
            ? 'copy.condition is null'
            : `copy.condition = ${sql.bind(criterion.condition)}`,
        );
        break;
      case 'identity':
        conditions.push(identityCriterionSql(query.resultLevel, criterion.references, sql));
        break;
    }
  }
  if (copyCriteria.length > 0) {
    conditions.push(`exists (select 1
      from usercards_private.copy as copy
      join usercards_private.printing_reference as copy_reference
        on copy_reference.printing_id = copy.printing_id
     where copy.account_id = :account_id
       and ${copyMatches(query.resultLevel)}
       and ${copyCriteria.join('\n       and ')})`);
  }
  const where = conditions.length === 0 ? 'true' : conditions.join('\n    and ');
  const direction = query.ordering.direction === 'descending' ? 'desc' : 'asc';
  const orderExpression =
    query.ordering.field === 'identity'
      ? `entry.target_id ${direction}`
      : query.ordering.field === 'ownedCopies'
        ? `entry.owned_copy_count ${direction}, entry.target_id asc`
        : query.ordering.field === 'intendedQuantity'
          ? `coalesce(entry.intended_quantity, 0) ${direction}, entry.target_id asc`
          : `entry.location_count ${direction}, entry.target_id asc`;
  sql.parameters.page_limit = query.pageSize;
  sql.parameters.page_offset = offset;
  sql.parameters.result_level = query.resultLevel;

  return {
    statement: `with scope_members as (
  ${scope}
), grouped as (
  select ${target} as target_id,
         count(distinct member.association_id) filter
           (where member.member_level = :result_level)::int as direct_association_count,
         count(distinct member.association_id) filter
           (where member.member_level <> :result_level)::int as derived_association_count,
         sum(member.quantity) filter (where member.quantity is not null)::int as intended_quantity
    from scope_members as member
   where ${target} is not null
   group by ${target}
), entry as (
  select grouped.*,
         (select count(*)::int
            from usercards_private.copy as copy
            join usercards_private.printing_reference as copy_reference
              on copy_reference.printing_id = copy.printing_id
            join usercards_private.association as owned
              on owned.account_id = copy.account_id and owned.target_level = 'copy'
             and owned.tag_kind = 'owned' and owned.target_id = copy.copy_id
           where copy.account_id = :account_id and ${copyMatches(query.resultLevel, 'grouped.target_id')}
         ) as owned_copy_count,
         (select count(distinct location.tag_id)::int
            from usercards_private.copy as copy
            join usercards_private.printing_reference as copy_reference
              on copy_reference.printing_id = copy.printing_id
            join usercards_private.association as location
              on location.account_id = copy.account_id and location.target_level = 'copy'
             and location.tag_kind = 'location' and location.target_id = copy.copy_id
           where copy.account_id = :account_id and ${copyMatches(query.resultLevel, 'grouped.target_id')}
         ) as location_count
    from grouped
), filtered as (
  select * from entry where ${where}
), page as (
  select * from filtered as entry
   order by ${orderExpression}
   limit :page_limit offset :page_offset
)
select 'entry' as row_kind,
       row_number() over (order by ${orderExpression})::int as row_position,
       json_build_object(
         'target_id', entry.target_id,
         'owned_copy_count', entry.owned_copy_count,
         'intended_quantity', entry.intended_quantity,
         'location_count', entry.location_count,
         'direct_association_count', entry.direct_association_count,
         'derived_association_count', entry.derived_association_count)::text as payload
  from page as entry
union all
select 'meta', 0,
       json_build_object(
         'revision', coalesce((select revision from usercards_private.account_state
                                where account_id = :account_id), 0),
         'total_count', (select count(*) from filtered),
         'tags_available', ${
           requiredTags.length === 0
             ? 'true'
             : `(select count(*) = ${requiredTags.length} from usercards_private.tag
                  where account_id = :account_id and tag_id in (${requiredTags.join(', ')}))`
         },
         'references_ready', not exists (
           select 1
             from (select copy.printing_id from usercards_private.copy as copy
                    where copy.account_id = :account_id
                   union
                   select association.target_id from usercards_private.association as association
                    where association.account_id = :account_id
                      and association.target_level = 'printing') as required
             left join usercards_private.printing_reference as prepared
               on prepared.printing_id = required.printing_id
            where prepared.printing_id is null))::text
order by row_kind, row_position`,
    parameters: sql.parameters,
  };
}

const queryEntrySchema = z.object({
  target_id: identifier,
  owned_copy_count: z.number().int().min(0),
  intended_quantity: z.number().int().min(1).nullable(),
  location_count: z.number().int().min(0),
  direct_association_count: z.number().int().min(0),
  derived_association_count: z.number().int().min(0),
});
const queryMetaSchema = z.object({
  revision: z.number().int().min(0),
  total_count: z.number().int().min(0),
  tags_available: z.boolean(),
  references_ready: z.boolean(),
});

function target(level: UserCardsResultLevel, id: string): UserCardsReference {
  if (level === 'card') return { kind: 'card', cardId: id };
  if (level === 'printing') return { kind: 'printing', printingId: id };
  return { kind: 'copy', copyId: id };
}

function fragmentStatement(
  accountId: string,
  references: readonly UserCardsReference[],
  tagId: string | undefined,
): {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, UserCardsSqlValue>>;
} {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    tag_id: tagId ?? null,
  };
  const values = references
    .map((reference, index) => {
      parameters[`reference_kind_${index}`] = reference.kind;
      parameters[`reference_id_${index}`] =
        reference.kind === 'card'
          ? reference.cardId
          : reference.kind === 'printing'
            ? reference.printingId
            : reference.copyId;
      return `(${index}, :reference_kind_${index}, :reference_id_${index})`;
    })
    .join(',\n       ');
  const requested =
    references.length === 0
      ? `select null::int as position, null::text as kind, null::text as reference_id where false`
      : `select * from (values ${values}) as input(position, kind, reference_id)`;
  const associationMatch = `(candidate.target_level = requested.kind
      and candidate.target_id = requested.reference_id)
    or (requested.kind = 'card' and candidate.target_level = 'printing' and exists (
      select 1 from usercards_private.printing_reference as association_reference
       where association_reference.printing_id = candidate.target_id
         and association_reference.card_id = requested.reference_id))
    or (candidate.target_level = 'copy' and exists (
      select 1
        from usercards_private.copy as associated_copy
        join usercards_private.printing_reference as association_reference
          on association_reference.printing_id = associated_copy.printing_id
       where associated_copy.account_id = candidate.account_id
         and associated_copy.copy_id = candidate.target_id
         and ((requested.kind = 'copy' and associated_copy.copy_id = requested.reference_id)
           or (requested.kind = 'printing' and associated_copy.printing_id = requested.reference_id)
           or (requested.kind = 'card' and association_reference.card_id = requested.reference_id))))`;
  const copyMatch = `(requested.kind = 'copy' and copy.copy_id = requested.reference_id)
    or (requested.kind = 'printing' and copy.printing_id = requested.reference_id)
    or (requested.kind = 'card' and copy_reference.card_id = requested.reference_id)`;
  return {
    statement: `with requested as (${requested}), fragments as (
  select requested.position, requested.kind, requested.reference_id,
         (requested.kind <> 'copy' or exists (
           select 1 from usercards_private.copy as present
            where present.account_id = :account_id and present.copy_id = requested.reference_id
         )) as available,
         (select count(*)::int
            from usercards_private.copy as copy
            join usercards_private.printing_reference as copy_reference
              on copy_reference.printing_id = copy.printing_id
            join usercards_private.association as owned
              on owned.account_id = copy.account_id and owned.target_level = 'copy'
             and owned.tag_kind = 'owned' and owned.target_id = copy.copy_id
           where copy.account_id = :account_id and (${copyMatch})) as owned_copy_count,
         (select count(distinct location.tag_id)::int
            from usercards_private.copy as copy
            join usercards_private.printing_reference as copy_reference
              on copy_reference.printing_id = copy.printing_id
            join usercards_private.association as location
              on location.account_id = copy.account_id and location.target_level = 'copy'
             and location.tag_kind = 'location' and location.target_id = copy.copy_id
           where copy.account_id = :account_id and (${copyMatch})) as location_count,
         coalesce((select jsonb_agg(tag_id order by tag_id)::text from (
           select distinct candidate.tag_id
             from usercards_private.association as candidate
            where candidate.account_id = :account_id and (${associationMatch})
         ) as matched_tags), '[]') as tag_ids,
         case when :tag_id is null then null else (
           select coalesce(sum(candidate.quantity), 0)::int
             from usercards_private.association as candidate
            where candidate.account_id = :account_id and candidate.tag_id = :tag_id
              and candidate.quantity is not null and (${associationMatch})
         ) end as intended_quantity
    from requested
)
select 'fragment' as row_kind, position as row_position,
       json_build_object('kind', kind, 'reference_id', reference_id, 'available', available,
         'owned_copy_count', owned_copy_count, 'location_count', location_count,
         'tag_ids', tag_ids::jsonb, 'intended_quantity', intended_quantity)::text as payload
  from fragments
union all
select 'meta', 0, json_build_object(
  'revision', coalesce((select revision from usercards_private.account_state
                         where account_id = :account_id), 0),
  'tag_available', (:tag_id is null or exists (
    select 1 from usercards_private.tag
     where account_id = :account_id and tag_id = :tag_id)),
  'references_ready', not exists (
    select 1
      from (select copy.printing_id from usercards_private.copy as copy
             where copy.account_id = :account_id
            union
            select association.target_id from usercards_private.association as association
             where association.account_id = :account_id
               and association.target_level = 'printing') as required
      left join usercards_private.printing_reference as prepared
        on prepared.printing_id = required.printing_id
     where prepared.printing_id is null))::text
order by row_kind, row_position`,
    parameters,
  };
}

const fragmentSchema = z.object({
  kind: z.enum(userCardsResultLevels),
  reference_id: identifier,
  available: z.boolean(),
  owned_copy_count: z.number().int().min(0),
  location_count: z.number().int().min(0),
  tag_ids: z.array(identifier),
  intended_quantity: z.number().int().min(0).nullable(),
});
const fragmentMetaSchema = z.object({
  revision: z.number().int().min(0),
  references_ready: z.boolean(),
  tag_available: z.boolean(),
});

export interface UserCardsQueries {
  query(context: TrustedUserContext, input: UserCardsQueryInput): Promise<UserCardsQueryPage>;
  readFragments(
    context: TrustedUserContext,
    input: ReadUserCardsFragmentsInput,
  ): Promise<UserCardsFragmentsResult>;
  readPhysicalDetail(context: TrustedUserContext, copyId: string): Promise<UserCardsPhysicalDetail>;
}

export function createUserCardsQueries(dependencies: {
  /** Account-scoped read storage; this capability never needs a writer or Catalog resolver. */
  readonly sql: UserCardsSqlExecutor;
}): UserCardsQueries {
  const sql = dependencies?.sql;
  if (typeof sql?.query !== 'function') {
    throw new TypeError('createUserCardsQueries requires a read-only SQL executor.');
  }
  return {
    async query(context, input) {
      const accountId = accountIdFrom(context);
      const normalized = normalizeUserCardsQuery(input);
      const fingerprint = queryFingerprint(accountId, normalized);
      const continuation = input.continuation === undefined ? null : readCursor(input.continuation);
      if (continuation !== null && continuation.fingerprint !== fingerprint) {
        throw staleContinuation();
      }
      const offset = continuation?.offset ?? 0;
      const request = queryStatement(accountId, normalized, offset);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private list could not be read.',
        ),
        ['entry', 'meta'] as const,
      );
      const meta = parsePayload(queryMetaSchema, rows.meta[0]?.payload);
      if (!meta.tags_available) {
        throw new UserCardsError(
          'not-found',
          'This account has no tag with a referenced identity.',
        );
      }
      if (!meta.references_ready) {
        throw new UserCardsError(
          'unavailable',
          'Stable references are still being prepared; retry the private query.',
        );
      }
      const revision = String(meta.revision);
      if (continuation !== null && continuation.revision !== revision) throw staleContinuation();
      const entries: UserCardsQueryEntry[] = rows.entry.map((row) => {
        const value = parsePayload(queryEntrySchema, row.payload);
        const entryTarget = target(normalized.resultLevel, value.target_id);
        return {
          entryKey: userCardsReferenceKey(entryTarget),
          target: entryTarget,
          ownedCopyCount: value.owned_copy_count,
          intendedQuantity: value.intended_quantity,
          physicalLocationCount: value.location_count,
          directAssociationCount: value.direct_association_count,
          derivedAssociationCount: value.derived_association_count,
        };
      });
      const nextOffset = offset + entries.length;
      return {
        entries,
        totalCount: meta.total_count,
        privateRevision: revision,
        continuation:
          nextOffset < meta.total_count
            ? encodeCursor({ version: 1, fingerprint, revision, offset: nextOffset })
            : null,
      };
    },

    async readFragments(context, input) {
      const accountId = accountIdFrom(context);
      const parsed = fragmentRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new UserCardsError(
          'invalid-request',
          `Private fragments accept at most ${USERCARDS_QUERY_LIMITS.maxFragmentReferences} typed references and an optional tag.`,
        );
      }
      const distinct = new Map(
        parsed.data.references.map((reference) => [userCardsReferenceKey(reference), reference]),
      );
      const references = [...distinct.values()];
      const request = fragmentStatement(accountId, references, parsed.data.tagId);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private fragments could not be read.',
        ),
        ['fragment', 'meta'] as const,
      );
      const meta = parsePayload(fragmentMetaSchema, rows.meta[0]?.payload);
      if (!meta.tag_available) {
        throw new UserCardsError('not-found', 'This account has no tag with that identity.');
      }
      if (!meta.references_ready) {
        throw new UserCardsError(
          'unavailable',
          'Stable references are still being prepared; retry the private fragments.',
        );
      }
      const fragments = new Map<string, UserCardsFragment>();
      const missing: UserCardsReference[] = [];
      for (const row of rows.fragment) {
        const value = parsePayload(fragmentSchema, row.payload);
        const reference = target(value.kind, value.reference_id);
        if (!value.available) {
          missing.push(reference);
          continue;
        }
        fragments.set(userCardsReferenceKey(reference), {
          reference,
          ownedCopyCount: value.owned_copy_count,
          tagIds: value.tag_ids,
          physicalLocationCount: value.location_count,
          intendedQuantity: value.intended_quantity,
        });
      }
      return { privateRevision: String(meta.revision), fragments, missing };
    },

    async readPhysicalDetail(context, copyId) {
      const accountId = accountIdFrom(context);
      if (!identifier.safeParse(copyId).success) {
        throw new UserCardsError('invalid-request', 'A readable copy reference is required.');
      }
      const rows = groupRows(
        await readRows(
          sql,
          `select 'copy' as row_kind, 0 as row_position,
                  json_build_object('copy_id', copy.copy_id, 'printing_id', copy.printing_id,
                    'finish', copy.finish, 'condition', copy.condition,
                    'revision', copy.revision)::text as payload
             from usercards_private.copy as copy
            where copy.account_id = :account_id and copy.copy_id = :copy_id
           union all
           select 'membership', row_number() over (order by association.association_id)::int,
                  json_build_object('association_id', association.association_id,
                    'tag_id', association.tag_id, 'target_level', association.target_level,
                    'target_id', association.target_id, 'quantity', association.quantity,
                    'revision', association.revision)::text
             from usercards_private.association as association
            where association.account_id = :account_id and association.target_level = 'copy'
              and association.target_id = :copy_id
           union all
           select 'revision', 0, json_build_object('revision', coalesce(
             (select revision from usercards_private.account_state where account_id = :account_id), 0))::text
           order by row_kind, row_position`,
          { account_id: accountId, copy_id: copyId },
          'The physical copy detail could not be read.',
        ),
        ['copy', 'membership', 'revision'] as const,
      );
      if (rows.copy[0] === undefined) {
        throw new UserCardsError('not-found', 'This account has no copy with that identity.');
      }
      // Parse through the same schemas as the record operations so detail cannot drift from them.
      parsePayload(copyJsonSchema, rows.copy[0].payload);
      for (const membership of rows.membership)
        parsePayload(associationJsonSchema, membership.payload);
      return {
        copy: copyFromRow(rows.copy[0]),
        memberships: associationsFromRows(rows.membership),
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
      };
    },
  };
}
