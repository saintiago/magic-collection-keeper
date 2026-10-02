/**
 * Transitional Catalog query publication retained for consumers awaiting replacement.
 *
 * Search consumes this provider-owned contract instead of reading SQL: a consistent, paginated
 * snapshot of the published revision with the change position it was read at, and the durable
 * changes published after a position. One publication writes its records' changes, its revision
 * and its position in one transaction, so a consumer observes a revision completely or not at all
 * and resuming from any delivered position leaves no gap between the snapshot and the changes.
 * Positions older than the retained publication history expire explicitly and require a new
 * snapshot instead of skipping changes silently.
 */

import { z } from 'zod';

import { CatalogError } from './errors.js';
import type { CatalogSqlExecutor, CatalogSqlRow, CatalogSqlValue } from './executor.js';
import {
  CATALOG_LIMITS,
  type CardFacts,
  type CardNameRecord,
  type CatalogRevision,
  type PrintingRecord,
} from './model.js';
import {
  cardJsonSchema,
  cardNameJsonSchema,
  parseJsonValue,
  parseJsonText,
  printingJsonSchema,
  revisionFromJson,
  revisionJsonExpression,
  revisionJsonSchema,
} from './records.js';

const identifierLength = CATALOG_LIMITS.maxIdentifierLength;

/**
 * Bounds the snapshot and change pages, and the publication history a change position can resume
 * from. Bounds stay provider-owned: a consumer reads further pages instead of raising them.
 */
export const CATALOG_PUBLICATION_LIMITS = {
  minPageSize: 1,
  defaultPageSize: 500,
  maxPageSize: 1000,
  /**
   * Publications whose changes stay readable. A snapshot can always be read again; a position that
   * the retention of older publications removed fails explicitly instead of skipping changes.
   */
  retainedPublications: 4,
} as const;

/**
 * Durable position of one change in the publication stream. Positions only grow, are opaque to
 * consumers and stay meaningful while the publication history that carries them is retained.
 */
export type CatalogChangePosition = string;

/** Stable identity of one published record, carried by removal changes that have no record. */
export type CatalogRecordReference =
  | { readonly kind: 'card'; readonly cardId: string }
  | {
      readonly kind: 'card-name';
      readonly cardId: string;
      readonly language: string;
      readonly name: string;
    }
  | { readonly kind: 'printing'; readonly printingId: string };

/** One published record of the catalog query surface. */
export type CatalogPublishedRecord =
  | { readonly kind: 'card'; readonly card: CardFacts }
  | { readonly kind: 'card-name'; readonly name: CardNameRecord }
  | { readonly kind: 'printing'; readonly printing: PrintingRecord };

/**
 * A complete published revision. It is written last inside the publication transaction, so a
 * consumer that applied this change holds every record of the revision named here.
 */
export interface CatalogRevisionChange {
  readonly kind: 'revision';
  readonly position: CatalogChangePosition;
  readonly revision: CatalogRevision;
}

/**
 * One record published by a revision: an upsert carrying the record, or a removal carrying only
 * its stable identity. Repeating a revision delivers the same meanings again.
 */
export interface CatalogRecordChange {
  readonly kind: 'card' | 'card-name' | 'printing';
  readonly position: CatalogChangePosition;
  /** Revision that published this record change. */
  readonly revisionId: string;
  readonly reference: CatalogRecordReference;
  /** True when the record is removed from the published facts; false for an upsert. */
  readonly removed: boolean;
  /** The published record of an upsert; `null` for a removal. */
  readonly record: CatalogPublishedRecord | null;
}

export type CatalogChange = CatalogRevisionChange | CatalogRecordChange;

export interface CatalogSnapshotRequest {
  /** Records one page carries, from 1 to {@link CATALOG_PUBLICATION_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
  /** Continuation of the previous page of the same snapshot; omitted to start a snapshot. */
  readonly continuation?: string;
}

export interface CatalogSnapshotPage {
  /** Retained completed publications incorporated by this snapshot; identities are opaque. */
  readonly incorporatedRevisions: readonly string[];
  /** The one published revision every record of this snapshot belongs to. */
  readonly revision: CatalogRevision;
  /**
   * Change position of that revision. Changes published after this snapshot follow it, so a
   * consumer resumes there without a gap.
   */
  readonly position: CatalogChangePosition;
  readonly records: readonly CatalogPublishedRecord[];
  /** Continuation of the next page of the same snapshot, or `null` when it is complete. */
  readonly continuation: string | null;
}

export interface CatalogChangesRequest {
  /** Position returned by a snapshot or by an earlier change page. */
  readonly position: CatalogChangePosition;
  /** Changes one page carries, from 1 to {@link CATALOG_PUBLICATION_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
}

export interface CatalogChangesPage {
  readonly changes: readonly CatalogChange[];
  /**
   * Position to resume from: the last delivered change, or the requested position when nothing
   * was published after it. The requested position expires explicitly instead of skipping.
   */
  readonly position: CatalogChangePosition;
}

/** The transitional snapshot and change contract consumed by Search. */
export interface CatalogPublication {
  readSnapshot(request?: CatalogSnapshotRequest): Promise<CatalogSnapshotPage>;
  readChanges(request: CatalogChangesRequest): Promise<CatalogChangesPage>;
}

export interface CatalogPublicationDependencies {
  /**
   * Read-only SQL executor supplied by Application with trusted publication access: the published
   * records and the durable publication stream, never a mutation capability.
   */
  readonly sql: CatalogSqlExecutor;
}

const positionSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[1-9][0-9]*$/, 'A change position is a positive decimal integer.');

const identifierSchema = z.string().min(1).max(identifierLength);

const snapshotRequestSchema = z
  .object({
    pageSize: z
      .number()
      .int()
      .min(CATALOG_PUBLICATION_LIMITS.minPageSize)
      .max(CATALOG_PUBLICATION_LIMITS.maxPageSize)
      .optional(),
    continuation: z.string().min(1).optional(),
  })
  .strict();

const changesRequestSchema = z
  .object({
    position: positionSchema,
    pageSize: z
      .number()
      .int()
      .min(CATALOG_PUBLICATION_LIMITS.minPageSize)
      .max(CATALOG_PUBLICATION_LIMITS.maxPageSize)
      .optional(),
  })
  .strict();

/**
 * Snapshot continuation: it names the revision and its change position, so a page read after the
 * catalog published another revision fails instead of mixing two revisions, and the offset is
 * stable while that revision stays published.
 */
const continuationPayloadSchema = z.object({
  version: z.literal(1),
  revision: identifierSchema,
  position: positionSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

type ContinuationPayload = z.infer<typeof continuationPayloadSchema>;

/**
 * Longest token `encodeContinuation` can emit: the revision is bounded by the identifier bound,
 * JSON escaping can spend six bytes on one string unit (`"\uXXXX"`), base64url expands by 4/3 and
 * the payload keys, the position and the integer offset fit the remaining margin. The decoder
 * accepts every token its encoder can produce.
 */
const maxContinuationLength = 4 * Math.ceil((6 * identifierLength + 192) / 3);

/**
 * One snapshot page: the published revision with its change position, plus the page of records in
 * the declared card, name, printing order. The revision row is read in the same statement as the
 * records, so the position and the page always describe one published revision.
 */
const snapshotPageStatement = `with page as (
  select '1'::text as kind_rank, card_id as record_key, 'card'::text as record_kind,
         to_jsonb(entry)::text as payload
  from (select card_id, name, rules_text, type_line, colors, color_identity, mana_value
        from catalog.cards) as entry
  union all
  select '2'::text, jsonb_build_array(card_id, language, name)::text, 'card-name'::text,
         to_jsonb(entry)::text
  from (select card_id, language, name from catalog.card_names) as entry
  union all
  select '3'::text, printing_id, 'printing'::text, to_jsonb(entry)::text
  from (select printing_id, card_id, edition, collector_number, language, finishes, physical,
               image_small, image_normal, image_large, image_art_crop
        from catalog.printings) as entry
)
select 'revision' as row_kind,
       0 as row_position,
       ${revisionJsonExpression} as payload,
       (select marker.position::text
          from catalog_private.publication as marker
         where marker.kind = 'revision' and marker.revision_id = revision.revision_id)
         as change_position,
       null::text as record_kind
from catalog.published_revision as revision
union all
select 'incorporated', 0, revision_id, null::text, null::text
from catalog_private.publication where kind = 'revision'
union all
(select 'record' as row_kind,
        (row_number() over (order by kind_rank, record_key))::int as row_position,
        payload,
        null::text as change_position,
        record_kind
   from page
  order by kind_rank, record_key
  limit :page_limit offset :page_offset)
order by row_kind, row_position`;

/**
 * One change page plus the retained bounds of the stream, so expiry is decided against the same
 * state the changes were read from. The bounds row also tells the reader when the catalog has no
 * published revision at all. The page takes the lowest durable positions — ordered by the stored
 * bigint, not the text the transport carries — and the result order repeats that numeric key, so
 * positions stay in order across a decimal digit boundary and across a sort that does not fit
 * memory, and the revision change that completes a revision follows the records it completes.
 */
const changesPageStatement = `with bounds as (
  select min(position)::text as oldest_position, max(position)::text as newest_position
  from catalog_private.publication
),
page as (
  select publication.position::text as position,
         publication.position as change_position,
         revision_id, source_name, source_version, published_at,
         kind, record_identity, removed, record::text as record
  from catalog_private.publication as publication
  where publication.position > cast(:after_position as bigint)
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
  row_kind: z.enum(['revision', 'record', 'incorporated']),
  row_position: z.number().int().min(0),
  payload: z.string(),
  change_position: positionSchema.nullable(),
  record_kind: z.enum(['card', 'card-name', 'printing']).nullable(),
});

const boundsRowSchema = z.object({
  oldest_position: positionSchema.nullable(),
  newest_position: positionSchema.nullable(),
});

const changeRowSchema = z.object({
  position: positionSchema,
  revision_id: identifierSchema,
  source_name: z.string().min(1).max(200),
  source_version: z.string().min(1).max(200),
  published_at: z.string().min(1),
  kind: z.enum(['revision', 'card', 'card-name', 'printing']),
  record_identity: z.string().min(1).nullable(),
  removed: z.boolean(),
  record: z.unknown(),
});

const cardNameIdentitySchema = z.tuple([
  identifierSchema,
  z.string().min(1).max(20),
  z.string().min(1).max(300),
]);

interface SnapshotData {
  readonly incorporatedRevisions: readonly string[];
  readonly revision: CatalogRevision;
  readonly position: CatalogChangePosition;
  readonly records: readonly CatalogPublishedRecord[];
}

interface ChangesData {
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly changes: readonly CatalogChange[];
}

/** The snapshot/change provider over the published records and the durable publication stream. */
export function createCatalogPublication(
  dependencies: CatalogPublicationDependencies,
): CatalogPublication {
  const sql: CatalogSqlExecutor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function') {
    throw new TypeError('createCatalogPublication requires a SQL executor with a query method.');
  }

  return {
    async readSnapshot(request: CatalogSnapshotRequest = {}): Promise<CatalogSnapshotPage> {
      const parsed = snapshotRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new CatalogError('invalid-request', snapshotRequestMessage(parsed.error));
      }
      const pageSize = parsed.data.pageSize ?? CATALOG_PUBLICATION_LIMITS.defaultPageSize;
      const continuation =
        parsed.data.continuation === undefined
          ? null
          : decodeContinuation(parsed.data.continuation);
      const offset = continuation?.offset ?? 0;

      const read = await readSnapshot(sql, offset, pageSize + 1);
      if (
        continuation !== null &&
        (read.revision.revisionId !== continuation.revision ||
          read.position !== continuation.position)
      ) {
        throw new CatalogError(
          'stale-continuation',
          'The catalog published another revision after this page was read; ' +
            'start the snapshot again.',
        );
      }
      const hasMore = read.records.length > pageSize;
      return {
        revision: read.revision,
        position: read.position,
        incorporatedRevisions: read.incorporatedRevisions,
        records: hasMore ? read.records.slice(0, pageSize) : read.records,
        continuation: hasMore
          ? encodeContinuation({
              version: 1,
              revision: read.revision.revisionId,
              position: read.position,
              offset: offset + pageSize,
            })
          : null,
      };
    },

    async readChanges(request: CatalogChangesRequest): Promise<CatalogChangesPage> {
      const parsed = changesRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new CatalogError(
          'invalid-request',
          'A change read needs the position a snapshot or an earlier change page returned, and ' +
            `a page size from ${CATALOG_PUBLICATION_LIMITS.minPageSize} to ` +
            `${CATALOG_PUBLICATION_LIMITS.maxPageSize}.`,
        );
      }
      const pageSize = parsed.data.pageSize ?? CATALOG_PUBLICATION_LIMITS.defaultPageSize;
      const read = await readChanges(sql, parsed.data.position, pageSize);
      if (read.oldest === null || read.newest === null) {
        throw new CatalogError('unavailable', 'The catalog has no published revision.');
      }
      const position = BigInt(parsed.data.position);
      if (position < BigInt(read.oldest) || position > BigInt(read.newest)) {
        throw new CatalogError(
          'stale-continuation',
          'This position is not part of the retained catalog publication history; ' +
            'read a new snapshot.',
        );
      }
      return {
        changes: read.changes,
        position: read.changes.at(-1)?.position ?? parsed.data.position,
      };
    },
  };
}

function snapshotRequestMessage(error: z.ZodError): string {
  const bounds =
    `a page size from ${CATALOG_PUBLICATION_LIMITS.minPageSize} to ` +
    `${CATALOG_PUBLICATION_LIMITS.maxPageSize}`;
  return error.issues.some((issue) => issue.path[0] === 'continuation')
    ? 'A snapshot continuation is a non-empty token returned by an earlier page.'
    : `A snapshot page accepts ${bounds}.`;
}

async function readSnapshot(
  sql: CatalogSqlExecutor,
  offset: number,
  limit: number,
): Promise<SnapshotData> {
  const rows = await readRows(sql, snapshotPageStatement, {
    page_limit: limit,
    page_offset: offset,
  });
  let revision: CatalogRevision | null = null;
  let position: string | null = null;
  const records: CatalogPublishedRecord[] = [];
  const incorporatedRevisions: string[] = [];
  for (const row of rows) {
    const parsed = snapshotRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new CatalogError('unavailable', 'The catalog returned a result that is not readable.');
    }
    if (parsed.data.row_kind === 'incorporated') {
      const identity = identifierSchema.safeParse(parsed.data.payload);
      if (!identity.success) {
        throw new CatalogError(
          'unavailable',
          'The catalog returned an unreadable revision identity.',
        );
      }
      incorporatedRevisions.push(identity.data);
    } else if (parsed.data.row_kind === 'revision') {
      revision = revisionFromJson(parseJsonText(revisionJsonSchema, parsed.data.payload));
      position = parsed.data.change_position;
    } else {
      records.push(decodeRecord(parsed.data.record_kind, parsed.data.payload));
    }
  }
  if (revision === null) {
    throw new CatalogError('unavailable', 'The catalog has no published revision.');
  }
  if (position === null) {
    throw new CatalogError(
      'unavailable',
      'The published catalog revision has no recorded publication position.',
    );
  }
  return { revision, position, records, incorporatedRevisions };
}

async function readChanges(
  sql: CatalogSqlExecutor,
  after: CatalogChangePosition,
  limit: number,
): Promise<ChangesData> {
  const rows = await readRows(sql, changesPageStatement, {
    after_position: after,
    page_limit: limit,
  });
  let oldest: string | null = null;
  let newest: string | null = null;
  const changes: CatalogChange[] = [];
  for (const row of rows) {
    switch (row.row_kind) {
      case 'bounds': {
        const bounds = boundsRowSchema.safeParse(parseJsonValue(row.payload));
        if (!bounds.success) {
          throw new CatalogError(
            'unavailable',
            'The catalog returned a result that is not readable.',
          );
        }
        oldest = bounds.data.oldest_position;
        newest = bounds.data.newest_position;
        break;
      }
      case 'change':
        changes.push(decodeChange(parseJsonText(changeRowSchema, row.payload)));
        break;
      default:
        throw new CatalogError(
          'unavailable',
          'The catalog returned a result that is not readable.',
        );
    }
  }
  return { oldest, newest, changes };
}

function decodeChange(row: z.infer<typeof changeRowSchema>): CatalogChange {
  if (row.kind === 'revision') {
    if (row.record !== null || row.record_identity !== null || row.removed) {
      throw unreadableChange();
    }
    return { kind: 'revision', position: row.position, revision: revisionFromJson(row) };
  }
  const identity = row.record_identity;
  if (identity === null) {
    throw unreadableChange();
  }
  const reference = decodeReference(row.kind, identity);
  if (row.removed && row.record !== null) {
    throw unreadableChange();
  }
  const record = row.removed ? null : decodeRecord(row.kind, row.record);
  if (record !== null && !sameIdentity(reference, record)) {
    throw unreadableChange();
  }
  return {
    kind: row.kind,
    position: row.position,
    revisionId: row.revision_id,
    reference,
    removed: row.removed,
    record,
  };
}

function decodeReference(
  kind: 'card' | 'card-name' | 'printing',
  identity: string,
): CatalogRecordReference {
  if (kind === 'card') {
    return { kind: 'card', cardId: identity };
  }
  if (kind === 'printing') {
    return { kind: 'printing', printingId: identity };
  }
  const parsed = cardNameIdentitySchema.safeParse(parseJsonIdentity(identity));
  if (!parsed.success) {
    throw unreadableChange();
  }
  return {
    kind: 'card-name',
    cardId: parsed.data[0],
    language: parsed.data[1],
    name: parsed.data[2],
  };
}

function decodeRecord(
  kind: 'card' | 'card-name' | 'printing' | null,
  payload: unknown,
): CatalogPublishedRecord {
  switch (kind) {
    case 'card': {
      const card = parseJsonText(cardJsonSchema, payload);
      return {
        kind: 'card',
        card: {
          cardId: card.card_id,
          name: card.name,
          rulesText: card.rules_text,
          typeLine: card.type_line,
          colors: card.colors,
          colorIdentity: card.color_identity,
          manaValue: card.mana_value,
        },
      };
    }
    case 'card-name': {
      const name = parseJsonText(cardNameJsonSchema, payload);
      return {
        kind: 'card-name',
        name: { cardId: name.card_id, language: name.language, name: name.name },
      };
    }
    case 'printing': {
      const printing = parseJsonText(printingJsonSchema, payload);
      const record: PrintingRecord = {
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
      };
      return { kind: 'printing', printing: record };
    }
    default:
      throw unreadableChange();
  }
}

/** Whether a decoded record still carries the stable identity its change was published under. */
function sameIdentity(reference: CatalogRecordReference, record: CatalogPublishedRecord): boolean {
  switch (reference.kind) {
    case 'card':
      return record.kind === 'card' && record.card.cardId === reference.cardId;
    case 'printing':
      return record.kind === 'printing' && record.printing.printingId === reference.printingId;
    case 'card-name':
      return (
        record.kind === 'card-name' &&
        record.name.cardId === reference.cardId &&
        record.name.language === reference.language &&
        record.name.name === reference.name
      );
  }
}

function parseJsonIdentity(identity: string): unknown {
  try {
    return JSON.parse(identity);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog returned unreadable result data.', {
      cause,
    });
  }
}

function unreadableChange(): CatalogError {
  return new CatalogError(
    'unavailable',
    'The catalog data does not match its declared read contract.',
  );
}

async function readRows(
  sql: CatalogSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, CatalogSqlValue>>,
): Promise<readonly CatalogSqlRow[]> {
  try {
    return await sql.query(statement, parameters);
  } catch (cause) {
    throw new CatalogError('unavailable', 'The catalog database could not be read.', { cause });
  }
}

function encodeContinuation(payload: ContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeContinuation(token: string): ContinuationPayload {
  const unreadable = new CatalogError(
    'invalid-request',
    'This snapshot continuation is not readable; start the snapshot again.',
  );
  if (typeof token !== 'string' || token.length === 0 || token.length > maxContinuationLength) {
    throw unreadable;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadable;
  }
  const parsed = continuationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadable;
  }
  return parsed.data;
}
