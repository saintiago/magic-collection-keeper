/**
 * UserCards query publication (docs/user-cards.md#query-surface).
 *
 * Search consumes this provider-owned contract instead of reading SQL: a consistent, paginated
 * snapshot of one account's published copies, tags and associations with the change position it
 * was read at, and the durable changes published after a position. Every query-visible mutation
 * appends its record changes and the revision that completes them in the same transaction as its
 * authoritative rows, so a consumer observes a logical mutation completely or not at all and
 * resuming from any delivered position leaves no gap between the snapshot and the changes.
 * Positions older than the retained publication history expire explicitly and require a new
 * snapshot instead of skipping changes; another account's position is not part of this account's
 * history and fails the same way. Pending import state has no published record, so it never
 * reaches the snapshot or the change stream.
 */

import { z } from 'zod';

import { finishes, type Finish } from '../../catalog/index.js';
import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';
import {
  USERCARDS_LIMITS,
  associationTargetLevels,
  copyConditions,
  tagKinds,
  type AssociationTargetLevel,
  type CopyCondition,
  type TagKind,
} from './model.js';
import { USERCARDS_ACCOUNT_SCOPE_SQL, usercardsQuerySchema } from './schema.js';
import { inTransaction, readRows } from './sql.js';

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

/**
 * Bounds the snapshot and change pages and the publication history a change position can resume
 * from. Bounds stay provider-owned: a consumer reads further pages instead of raising them.
 */
export const USERCARDS_PUBLICATION_LIMITS = {
  minPageSize: 1,
  defaultPageSize: 500,
  maxPageSize: 1000,
  /**
   * Publications whose changes stay readable for one account. A snapshot can always be read
   * again; a position the retention of older publications removed fails explicitly instead of
   * skipping changes. Every query-visible mutation publishes one revision, so this bounds the
   * change history of an account by its publications, not by individual record changes.
   */
  retainedRevisions: 8,
} as const;

/**
 * Durable position of one change in one account's publication stream. Positions only grow and are
 * opaque to consumers; zero means "before everything this account published".
 */
export type UserCardsChangePosition = string;

/** Stable identity of one published record, carried by removal changes that have no record. */
export type UserCardsRecordReference =
  | { readonly kind: 'copy'; readonly copyId: string }
  | { readonly kind: 'tag'; readonly tagId: string }
  | { readonly kind: 'association'; readonly associationId: string };

/** One physical copy as the query surface publishes it, with its derived ownership and location. */
export interface UserCardsCopyRecord {
  readonly copyId: string;
  readonly printingId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
  /** Whether the copy carries the account's system owned association. */
  readonly owned: boolean;
  /** Tag identity of the copy's single physical location; null while it has none. */
  readonly locationId: string | null;
}

/** One tag as the query surface publishes it. */
export interface UserCardsTagRecord {
  readonly tagId: string;
  readonly kind: TagKind;
  readonly label: string;
  readonly system: boolean;
}

/** One association as the query surface publishes it. */
export interface UserCardsAssociationRecord {
  readonly associationId: string;
  readonly tagId: string;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity: number | null;
}

/** One published record of the private query surface. */
export type UserCardsPublishedRecord =
  | { readonly kind: 'copy'; readonly copy: UserCardsCopyRecord }
  | { readonly kind: 'tag'; readonly tag: UserCardsTagRecord }
  | { readonly kind: 'association'; readonly association: UserCardsAssociationRecord };

/**
 * A complete published revision of one account. It is written after every record change of its
 * mutation, so a consumer that applied this change holds every record the mutation changed.
 */
export interface UserCardsRevisionChange {
  readonly kind: 'revision';
  readonly position: UserCardsChangePosition;
  readonly accountId: string;
  /** Account-scoped private-data revision this publication advanced to. */
  readonly revision: string;
}

/**
 * One record published by a mutation: an upsert carrying the record, or a removal carrying only
 * its stable identity. Repeating a change delivers the same meaning again.
 */
export interface UserCardsRecordChange {
  readonly kind: 'copy' | 'tag' | 'association';
  readonly position: UserCardsChangePosition;
  readonly accountId: string;
  /** Account-scoped private-data revision that published this record change. */
  readonly revision: string;
  readonly reference: UserCardsRecordReference;
  /** True when the record is removed from the published records; false for an upsert. */
  readonly removed: boolean;
  /** The published record of an upsert; `null` for a removal. */
  readonly record: UserCardsPublishedRecord | null;
}

export type UserCardsChange = UserCardsRevisionChange | UserCardsRecordChange;

export interface UserCardsSnapshotRequest {
  /** Account whose published records the snapshot reads. */
  readonly accountId: string;
  /** Records one page carries, from 1 to {@link USERCARDS_PUBLICATION_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
  /** Continuation of the previous page of the same snapshot; omitted to start a snapshot. */
  readonly continuation?: string;
}

export interface UserCardsSnapshotPage {
  readonly accountId: string;
  /**
   * Change position this snapshot was read at. Changes published after it follow it, so a
   * consumer resumes there without a gap; zero means the account published nothing yet.
   */
  readonly position: UserCardsChangePosition;
  readonly records: readonly UserCardsPublishedRecord[];
  /** Continuation of the next page of the same snapshot, or `null` when it is complete. */
  readonly continuation: string | null;
}

export interface UserCardsChangesRequest {
  /** Account whose changes the page reads; another account's position never resumes here. */
  readonly accountId: string;
  /** Position returned by a snapshot or by an earlier change page. */
  readonly position: UserCardsChangePosition;
  /** Changes one page carries, from 1 to {@link USERCARDS_PUBLICATION_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
}

export interface UserCardsChangesPage {
  readonly accountId: string;
  readonly changes: readonly UserCardsChange[];
  /**
   * Position to resume from: the last delivered change, or the requested position when nothing
   * was published after it. An expired or foreign position fails explicitly instead of skipping.
   */
  readonly position: UserCardsChangePosition;
}

/** The snapshot and change contract Search reads (docs/user-cards.md#query-surface). */
export interface UserCardsPublication {
  readSnapshot(request: UserCardsSnapshotRequest): Promise<UserCardsSnapshotPage>;
  readChanges(request: UserCardsChangesRequest): Promise<UserCardsChangesPage>;
}

export interface UserCardsPublicationDependencies {
  /**
   * Transaction-capable SQL executor supplied by Application with trusted publication access: the
   * account-scoped published relations and the durable publication stream, never a mutation
   * capability. The account is bound inside the read transaction, so a missing scope fails closed.
   */
  readonly sql: UserCardsSqlTransactor;
}

/** A change position: zero, or a positive decimal integer without leading zeros. */
export const changePositionSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/, 'A change position is a non-negative decimal integer.');

const accountIdSchema = z.string().min(1).max(identifierLength);

const snapshotRequestSchema = z
  .object({
    accountId: accountIdSchema,
    pageSize: z
      .number()
      .int()
      .min(USERCARDS_PUBLICATION_LIMITS.minPageSize)
      .max(USERCARDS_PUBLICATION_LIMITS.maxPageSize)
      .optional(),
    continuation: z.string().min(1).optional(),
  })
  .strict();

const changesRequestSchema = z
  .object({
    accountId: accountIdSchema,
    position: changePositionSchema,
    pageSize: z
      .number()
      .int()
      .min(USERCARDS_PUBLICATION_LIMITS.minPageSize)
      .max(USERCARDS_PUBLICATION_LIMITS.maxPageSize)
      .optional(),
  })
  .strict();

/**
 * Snapshot continuation: it names the account's change position, so a page read after the account
 * published another revision fails instead of mixing two positions, and the offset stays stable
 * while that position remains published.
 */
const continuationPayloadSchema = z.object({
  version: z.literal(1),
  position: changePositionSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

type ContinuationPayload = z.infer<typeof continuationPayloadSchema>;

/**
 * Longest token `encodeContinuation` can emit: JSON escaping can spend six bytes on one string
 * unit, base64url expands by 4/3, and the payload keys, the position and the integer offset fit
 * the remaining margin. The decoder accepts every token its encoder can produce.
 */
const maxContinuationLength = 4 * Math.ceil((6 * 20 + 192) / 3);

/**
 * One snapshot page: the account's change position and the page of its published records in the
 * declared copy, tag, association order, read in one statement. The relations are account-scoped
 * at the database boundary, so the records and the position always describe one account and one
 * published state.
 */
const snapshotPageStatement = `with marker as (
  select coalesce(max(publication.position), 0)::text as position
    from usercards_private.publication as publication
   where publication.account_id = :account_id and publication.kind = 'revision'
),
records as (
  select '1'::text as kind_rank, published.copy_id as record_key, 'copy'::text as record_kind,
         to_jsonb(published)::text as payload
    from ${usercardsQuerySchema}.copies as published
  union all
  select '2'::text, published.tag_id, 'tag'::text, to_jsonb(published)::text
    from ${usercardsQuerySchema}.tags as published
  union all
  select '3'::text, published.association_id, 'association'::text, to_jsonb(published)::text
    from ${usercardsQuerySchema}.associations as published
)
select 'position' as row_kind, 0 as row_position, null::text as record_kind,
       marker.position as payload
  from marker
union all
(select 'record' as row_kind,
        (row_number() over (order by records.kind_rank, records.record_key))::int as row_position,
        records.record_kind,
        records.payload
   from records
  order by records.kind_rank, records.record_key
  limit :page_limit offset :page_offset)
order by row_kind, row_position`;

/**
 * One change page plus the expiry floor of one account's retained history and whether the resume
 * position is one this account published, so both are decided against the same state the changes
 * were read from. Positions grow across every account, so a numeric bound alone admits another
 * account's position inside this account's retained range; only membership in this account's own
 * stream rules that out, because resuming from it would skip this account's earlier changes. The
 * page takes the lowest durable positions — ordered by the stored bigint, not the text the
 * transport carries — and the result order repeats that numeric key, so positions stay in order
 * across a decimal digit boundary and across a sort that does not fit memory, and the revision
 * change that completes a mutation follows the records it completes.
 */
const changesPageStatement = `with bounds as (
  select coalesce((select state.expired_below
                     from usercards_private.account_state as state
                    where state.account_id = :account_id), 0)::text as expired_below,
         exists (select 1
                   from usercards_private.publication as resumed
                  where resumed.account_id = :account_id
                    and resumed.position = cast(:after_position as bigint)) as position_published
),
page as (
  select publication.position::text as position,
         publication.position as change_position,
         publication.revision, publication.kind, publication.record_identity, publication.removed,
         publication.record::text as record
    from usercards_private.publication as publication
   where publication.account_id = :account_id
     and publication.position > cast(:after_position as bigint)
   order by publication.position
   limit :page_limit
)
select 'bounds' as row_kind, null::bigint as row_position, to_jsonb(bounds)::text as payload
  from bounds
union all
select 'change' as row_kind, page.change_position, (to_jsonb(page) - 'change_position')::text
  from page
order by row_kind, row_position`;

const snapshotRowSchema = z.object({
  row_kind: z.enum(['position', 'record']),
  row_position: z.number().int().min(0),
  record_kind: z.enum(['copy', 'tag', 'association']).nullable(),
  payload: z.string(),
});

const boundsRowSchema = z.object({
  expired_below: changePositionSchema,
  position_published: z.boolean(),
});

const changeRowSchema = z.object({
  position: changePositionSchema,
  revision: z.union([z.number().int().min(1), z.string().regex(/^[1-9][0-9]*$/)]),
  kind: z.enum(['revision', 'copy', 'tag', 'association']),
  record_identity: z.string().min(1).max(identifierLength).nullable(),
  removed: z.boolean(),
  record: z.unknown(),
});

/** Published record payloads, matching the columns of the declared query surface relations. */
const copyRecordJsonSchema = z.object({
  copy_id: z.string().min(1).max(identifierLength),
  printing_id: z.string().min(1).max(identifierLength),
  finish: z.enum(finishes),
  condition: z.enum(copyConditions).nullable(),
  owned: z.boolean(),
  location_id: z.string().min(1).max(identifierLength).nullable(),
});

const tagRecordJsonSchema = z.object({
  tag_id: z.string().min(1).max(identifierLength),
  kind: z.enum(tagKinds),
  label: z.string().min(1).max(identifierLength),
  system: z.boolean(),
});

const associationRecordJsonSchema = z.object({
  association_id: z.string().min(1).max(identifierLength),
  tag_id: z.string().min(1).max(identifierLength),
  target_level: z.enum(associationTargetLevels),
  target_id: z.string().min(1).max(identifierLength),
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxAssociationQuantity).nullable(),
});

interface SnapshotData {
  readonly position: UserCardsChangePosition;
  readonly records: readonly UserCardsPublishedRecord[];
}

interface ChangesData {
  readonly expiredBelow: string;
  /** Whether the account published the requested resume position; zero never needs one. */
  readonly positionPublished: boolean;
  readonly changes: readonly UserCardsChange[];
}

/** The snapshot/change provider over one account's published records. */
export function createUserCardsPublication(
  dependencies: UserCardsPublicationDependencies,
): UserCardsPublication {
  const sql: UserCardsSqlTransactor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') {
    throw new TypeError('createUserCardsPublication requires a transaction-capable SQL executor.');
  }

  return {
    async readSnapshot(request: UserCardsSnapshotRequest): Promise<UserCardsSnapshotPage> {
      const parsed = snapshotRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new UserCardsError('invalid-request', snapshotRequestMessage(parsed.error));
      }
      const accountId = parsed.data.accountId;
      const pageSize = parsed.data.pageSize ?? USERCARDS_PUBLICATION_LIMITS.defaultPageSize;
      const continuation =
        parsed.data.continuation === undefined
          ? null
          : decodeContinuation(parsed.data.continuation);
      const offset = continuation?.offset ?? 0;

      const read = await readSnapshotPage(sql, accountId, offset, pageSize + 1);
      if (continuation !== null && read.position !== continuation.position) {
        throw new UserCardsError(
          'stale-continuation',
          'The account published another revision after this page was read; ' +
            'start the snapshot again.',
        );
      }
      const hasMore = read.records.length > pageSize;
      return {
        accountId,
        position: read.position,
        records: hasMore ? read.records.slice(0, pageSize) : read.records,
        continuation: hasMore
          ? encodeContinuation({
              version: 1,
              position: read.position,
              offset: offset + pageSize,
            })
          : null,
      };
    },

    async readChanges(request: UserCardsChangesRequest): Promise<UserCardsChangesPage> {
      const parsed = changesRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new UserCardsError(
          'invalid-request',
          'A change read needs an account, the position a snapshot or an earlier change page ' +
            `returned, and a page size from ${USERCARDS_PUBLICATION_LIMITS.minPageSize} to ` +
            `${USERCARDS_PUBLICATION_LIMITS.maxPageSize}.`,
        );
      }
      const accountId = parsed.data.accountId;
      const pageSize = parsed.data.pageSize ?? USERCARDS_PUBLICATION_LIMITS.defaultPageSize;
      const read = await readChangePage(sql, accountId, parsed.data.position, pageSize);
      const position = BigInt(parsed.data.position);
      if (position < BigInt(read.expiredBelow)) {
        throw new UserCardsError(
          'stale-continuation',
          'This position is not part of the retained private publication history; ' +
            'read a new snapshot.',
        );
      }
      // Zero means "before everything this account published" and needs no published position.
      // Every other resume position must be one this account published: another account's
      // position inside the retained range would otherwise resume mid-gap, silently skipping the
      // changes this account published before it.
      if (position !== 0n && !read.positionPublished) {
        throw new UserCardsError(
          'stale-continuation',
          'This position is not part of this account’s publication history; ' +
            'read a new snapshot.',
        );
      }
      return {
        accountId,
        changes: read.changes,
        position: read.changes.at(-1)?.position ?? parsed.data.position,
      };
    },
  };
}

function snapshotRequestMessage(error: z.ZodError): string {
  const bounds =
    `a page size from ${USERCARDS_PUBLICATION_LIMITS.minPageSize} to ` +
    `${USERCARDS_PUBLICATION_LIMITS.maxPageSize}`;
  return error.issues.some((issue) => issue.path[0] === 'continuation')
    ? 'A snapshot continuation is a non-empty token returned by an earlier page.'
    : `A snapshot read needs an account, ${bounds} and an optional continuation.`;
}

/** Reads one snapshot page inside a transaction that binds the requested account. */
async function readSnapshotPage(
  sql: UserCardsSqlTransactor,
  accountId: string,
  offset: number,
  limit: number,
): Promise<SnapshotData> {
  return inTransaction(
    sql,
    async (statements) => {
      await bindAccount(statements, accountId);
      const rows = await readRows(
        statements,
        snapshotPageStatement,
        { account_id: accountId, page_limit: limit, page_offset: offset },
        'The published private records could not be read.',
      );
      return decodeSnapshot(rows);
    },
    'The published private records could not be read.',
  );
}

/** Reads one change page of one account inside a transaction that binds the same account. */
async function readChangePage(
  sql: UserCardsSqlTransactor,
  accountId: string,
  after: UserCardsChangePosition,
  limit: number,
): Promise<ChangesData> {
  return inTransaction(
    sql,
    async (statements) => {
      await bindAccount(statements, accountId);
      const rows = await readRows(
        statements,
        changesPageStatement,
        { account_id: accountId, after_position: after, page_limit: limit },
        'The published private changes could not be read.',
      );
      return decodeChanges(accountId, rows);
    },
    'The published private changes could not be read.',
  );
}

async function bindAccount(statements: UserCardsSqlExecutor, accountId: string): Promise<void> {
  await readRows(
    statements,
    USERCARDS_ACCOUNT_SCOPE_SQL,
    { account_id: accountId },
    'The publication account scope could not be bound.',
  );
}

function decodeSnapshot(rows: readonly UserCardsSqlRow[]): SnapshotData {
  let position: string | null = null;
  const records: UserCardsPublishedRecord[] = [];
  for (const row of rows) {
    const parsed = snapshotRowSchema.safeParse(row);
    if (!parsed.success) {
      throw unreadable();
    }
    if (parsed.data.row_kind === 'position') {
      position = parsePosition(parsed.data.payload);
    } else {
      records.push(decodeRecord(parsed.data.record_kind, parsed.data.payload));
    }
  }
  if (position === null) {
    throw new UserCardsError(
      'unavailable',
      'UserCards did not report the account’s publication position.',
    );
  }
  return { position, records };
}

function decodeChanges(accountId: string, rows: readonly UserCardsSqlRow[]): ChangesData {
  let expiredBelow: string | null = null;
  let positionPublished = false;
  const changes: UserCardsChange[] = [];
  for (const row of rows) {
    switch (row.row_kind) {
      case 'bounds': {
        const bounds = boundsRowSchema.safeParse(parseJsonValue(row.payload));
        if (!bounds.success) {
          throw unreadable();
        }
        expiredBelow = bounds.data.expired_below;
        positionPublished = bounds.data.position_published;
        break;
      }
      case 'change':
        changes.push(decodeChange(accountId, parseJsonText(changeRowSchema, row.payload)));
        break;
      default:
        throw unreadable();
    }
  }
  if (expiredBelow === null) {
    throw unreadable();
  }
  return { expiredBelow, positionPublished, changes };
}

function decodeChange(accountId: string, row: z.infer<typeof changeRowSchema>): UserCardsChange {
  const revision = String(row.revision);
  if (row.kind === 'revision') {
    if (row.record !== null || row.record_identity !== null || row.removed) {
      throw unreadable();
    }
    return { kind: 'revision', position: row.position, accountId, revision };
  }
  const identity = row.record_identity;
  if (identity === null) {
    throw unreadable();
  }
  const reference = decodeReference(row.kind, identity);
  if (row.removed && row.record !== null) {
    throw unreadable();
  }
  const record = row.removed ? null : decodeRecord(row.kind, row.record);
  if (record !== null && !sameIdentity(reference, record)) {
    throw unreadable();
  }
  return {
    kind: row.kind,
    position: row.position,
    accountId,
    revision,
    reference,
    removed: row.removed,
    record,
  };
}

function decodeReference(
  kind: 'copy' | 'tag' | 'association',
  identity: string,
): UserCardsRecordReference {
  switch (kind) {
    case 'copy':
      return { kind: 'copy', copyId: identity };
    case 'tag':
      return { kind: 'tag', tagId: identity };
    case 'association':
      return { kind: 'association', associationId: identity };
  }
}

function decodeRecord(
  kind: 'copy' | 'tag' | 'association' | null,
  payload: unknown,
): UserCardsPublishedRecord {
  switch (kind) {
    case 'copy': {
      const copy = parseJsonText(copyRecordJsonSchema, payload);
      return {
        kind: 'copy',
        copy: {
          copyId: copy.copy_id,
          printingId: copy.printing_id,
          finish: copy.finish,
          condition: copy.condition,
          owned: copy.owned,
          locationId: copy.location_id,
        },
      };
    }
    case 'tag': {
      const tag = parseJsonText(tagRecordJsonSchema, payload);
      return {
        kind: 'tag',
        tag: {
          tagId: tag.tag_id,
          kind: tag.kind,
          label: tag.label,
          system: tag.system,
        },
      };
    }
    case 'association': {
      const association = parseJsonText(associationRecordJsonSchema, payload);
      return {
        kind: 'association',
        association: {
          associationId: association.association_id,
          tagId: association.tag_id,
          targetLevel: association.target_level,
          targetId: association.target_id,
          quantity: association.quantity,
        },
      };
    }
    default:
      throw unreadable();
  }
}

/** Whether a decoded record still carries the stable identity its change was published under. */
function sameIdentity(
  reference: UserCardsRecordReference,
  record: UserCardsPublishedRecord,
): boolean {
  switch (reference.kind) {
    case 'copy':
      return record.kind === 'copy' && record.copy.copyId === reference.copyId;
    case 'tag':
      return record.kind === 'tag' && record.tag.tagId === reference.tagId;
    case 'association':
      return (
        record.kind === 'association' &&
        record.association.associationId === reference.associationId
      );
  }
}

function unreadable(): UserCardsError {
  return new UserCardsError(
    'unavailable',
    'The private data does not match its declared publication contract.',
  );
}

function parsePosition(value: unknown): string {
  const parsed = changePositionSchema.safeParse(value);
  if (!parsed.success) {
    throw unreadable();
  }
  return parsed.data;
}

function parseJsonValue(value: UserCardsSqlValue | undefined): unknown {
  if (typeof value !== 'string') {
    throw unreadable();
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw unreadable();
  }
}

function parseJsonText<T>(schema: z.ZodType<T>, value: unknown): T {
  const decoded = typeof value === 'string' ? parseJsonValue(value) : value;
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadable();
  }
  return parsed.data;
}

function encodeContinuation(payload: ContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeContinuation(token: string): ContinuationPayload {
  const unreadableToken = new UserCardsError(
    'invalid-request',
    'This snapshot continuation is not readable; start the snapshot again.',
  );
  if (typeof token !== 'string' || token.length === 0 || token.length > maxContinuationLength) {
    throw unreadableToken;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadableToken;
  }
  const parsed = continuationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadableToken;
  }
  return parsed.data;
}
