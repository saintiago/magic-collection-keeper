/**
 * Migration persistence (docs/migration.md#rehearsal-and-execution-gates). A migration records the
 * verified prepared plan it loads and the exact archive its source digest covers, applies the plan
 * as batches whose records, replay receipt and query-visible publication commit together, and reads
 * back the authoritative records for reconciliation. Every transaction takes the account's lock
 * first, so two loaders of one account cannot both apply a batch or both find the account empty.
 */

import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlRow,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';
import { ensureOwnedTag, storeCopiesWithOwnedTag } from './copies.js';
import {
  entriesPerRead,
  integerValue,
  sessionGroupBySql,
  sessionSelectSql,
  textValue,
  type Statement,
} from './imports/session-state.js';
import {
  migrationArchiveDigest,
  migrationSourceLineKey,
  type MigrationBatch,
  type PlannedAssociation,
} from './migration-plan.js';
import { type ImportEntry } from './model.js';
import { advanceRevision } from './revision.js';
import {
  associationPayloadSql,
  associationsFromRows,
  copyPayloadSql,
  copiesFromRows,
  importCandidatePayloadSql,
  importEntriesFromRows,
  importEntryPayloadSql,
  importSessionFromRow,
  importSourceLinePayload,
  tagPayloadSql,
  tagsFromRows,
} from './rows.js';
import { batches, groupRows, inTransaction, readRows } from './sql.js';
import type {
  MigrationBatchOutcome,
  MigrationProgress,
  MigrationReadbackOutcome,
  MigrationRecord,
  MigrationRecordedOutcome,
  MigrationStartOutcome,
  MigrationStore,
} from './store.js';

/** Entries one migration statement carries, so a bounded source line stays inside the bound. */
const entriesPerStatement = 10;
/** Rows one readback statement returns for the records of one kind. */
const readbackRowsPerRead = 200;
/** Archive chunks one readback statement reassembles; a chunk is bounded to 48 KiB. */
const archiveChunksPerRead = 8;

function fail(message: string): UserCardsError {
  return new UserCardsError('unavailable', message);
}

/** One insert statement together with the records it carries. */
interface InsertedRows {
  readonly statement: Statement;
  readonly count: number;
}

function inserted(statement: Statement, count: number): InsertedRows {
  return { statement, count };
}

/**
 * Takes the account's private lock and creates its state row when it has none. A migration's
 * setup, every batch and its completion serialize on this row, so a retry always observes the
 * receipts of an interrupted run.
 */
function lockAccountStatement(accountId: string): Statement {
  return {
    statement: `insert into usercards_private.account_state (account_id, revision)
     values (:account_id, 0)
     on conflict (account_id) do update set revision = usercards_private.account_state.revision
     returning revision::text as revision`,
    parameters: { account_id: accountId },
  };
}

async function lockAccount(statements: UserCardsSqlExecutor, accountId: string): Promise<void> {
  const request = lockAccountStatement(accountId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The migration account could not be locked.',
  );
  const revision = rows[0]?.revision;
  if (typeof revision !== 'string' || !/^[0-9]+$/.test(revision)) {
    throw fail('UserCards did not report the account state of the migration.');
  }
}

interface RecordedMigration {
  readonly planDigest: string;
  readonly sourceDigest: string;
  readonly batchCount: number;
  readonly state: 'loading' | 'completed';
  readonly publicationPosition: string | null;
}

/** Reads the recorded migration of this snapshot, if any, and locks it for the transaction. */
async function readRecordedMigration(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
): Promise<RecordedMigration | null> {
  const rows = await readRows(
    statements,
    `select plan_digest, source_digest, batch_count, state,
            publication_position::text as publication_position
       from usercards_private.migration
      where account_id = :account_id and migration_id = :migration_id
        for update`,
    { account_id: accountId, migration_id: migrationId },
    'The recorded migration could not be read.',
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const state = textValue(row.state);
  if (state !== 'loading' && state !== 'completed') {
    throw fail('The recorded migration carries an unknown state.');
  }
  return {
    planDigest: textValue(row.plan_digest),
    sourceDigest: textValue(row.source_digest),
    batchCount: integerValue(row.batch_count),
    state,
    publicationPosition: nullablePosition(row.publication_position),
  };
}

/** A publication position column: null when the change published no query-visible record. */
function nullablePosition(value: UserCardsSqlValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return textValue(value);
}

async function readBatchReceipts(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
): Promise<MigrationProgress['batches']> {
  const rows = await readRows(
    statements,
    `select batch_index, fingerprint
       from usercards_private.migration_batch
      where account_id = :account_id and migration_id = :migration_id
      order by batch_index`,
    { account_id: accountId, migration_id: migrationId },
    'The recorded migration batches could not be read.',
  );
  return rows.map((row) => ({
    index: integerValue(row.batch_index),
    fingerprint: textValue(row.fingerprint),
  }));
}

/** Whether the account already holds private records a migration must not mix with. */
async function accountHoldsRecords(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<boolean> {
  const rows = await readRows(
    statements,
    `select (exists (select 1 from usercards_private.copy
                      where account_id = :account_id)
          or exists (select 1 from usercards_private.tag
                      where account_id = :account_id)
          or exists (select 1 from usercards_private.association
                      where account_id = :account_id)
          or exists (select 1 from usercards_private.import_session
                      where account_id = :account_id)
          or exists (select 1 from usercards_private.import_entry
                      where account_id = :account_id)
          or exists (select 1 from usercards_private.migration
                      where account_id = :account_id)) as nonempty`,
    { account_id: accountId },
    'The target account could not be read.',
  );
  const nonempty = rows[0]?.nonempty;
  if (typeof nonempty !== 'boolean') {
    throw fail('UserCards did not report whether the target account holds records.');
  }
  return nonempty;
}

async function insertMigration(
  statements: UserCardsSqlExecutor,
  accountId: string,
  record: MigrationRecord,
): Promise<void> {
  const rows = await readRows(
    statements,
    `insert into usercards_private.migration
       (migration_id, account_id, plan_digest, source_digest, batch_count, state)
     values (:migration_id, :account_id, :plan_digest, :source_digest, :batch_count, 'loading')
     returning migration_id`,
    {
      migration_id: record.migrationId,
      account_id: accountId,
      plan_digest: record.planDigest,
      source_digest: record.sourceDigest,
      batch_count: record.batchCount,
    },
    'The migration could not be recorded.',
  );
  if (rows.length !== 1) {
    throw fail('UserCards did not record the migration.');
  }
}

/** Stores the durable archive evidence in bounded chunks; its concatenation is the source digest. */
async function insertArchive(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
  archive: readonly string[],
): Promise<void> {
  for (const [index, content] of archive.entries()) {
    const rows = await readRows(
      statements,
      `insert into usercards_private.migration_archive
         (account_id, migration_id, chunk_index, content)
       values (:account_id, :migration_id, :chunk_index, :content)
       returning chunk_index`,
      { account_id: accountId, migration_id: migrationId, chunk_index: index, content },
      'The migration archive could not be recorded.',
    );
    if (rows.length !== 1) {
      throw fail('UserCards did not record the migration archive.');
    }
  }
}

function insertTagsStatement(
  accountId: string,
  tags: readonly { readonly tagId: string; readonly kind: string; readonly label: string }[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = tags
    .map((tag, index) => {
      parameters[`tag_id_${index}`] = tag.tagId;
      parameters[`kind_${index}`] = tag.kind;
      parameters[`label_${index}`] = tag.label;
      return `(:tag_id_${index}, :account_id, :kind_${index}, :label_${index}, false, 1)`;
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.tag (tag_id, account_id, kind, label, system, revision)
     values ${values}
     returning tag_id`,
    parameters,
  };
}

function insertAssociationsStatement(
  accountId: string,
  associations: readonly PlannedAssociation[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = associations
    .map(({ association, tagKind }, index) => {
      parameters[`association_id_${index}`] = association.associationId;
      parameters[`tag_id_${index}`] = association.tagId;
      parameters[`tag_kind_${index}`] = tagKind;
      parameters[`target_level_${index}`] = association.targetLevel;
      parameters[`target_id_${index}`] = association.targetId;
      parameters[`quantity_${index}`] = association.quantity;
      return (
        `(:association_id_${index}, :account_id, :tag_id_${index}, :tag_kind_${index}, ` +
        `:target_level_${index}, :target_id_${index}, :quantity_${index}, 1)`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.association
       (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
     values ${values}
     returning association_id`,
    parameters,
  };
}

function insertSessionsStatement(
  accountId: string,
  sessions: readonly {
    readonly sessionId: string;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly sourceReference: string | null;
  }[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = sessions
    .map((session, index) => {
      parameters[`session_id_${index}`] = session.sessionId;
      parameters[`source_kind_${index}`] = session.sourceKind;
      parameters[`source_id_${index}`] = session.sourceId;
      parameters[`source_reference_${index}`] = session.sourceReference;
      return (
        `(:session_id_${index}, :account_id, :source_kind_${index}, :source_id_${index}, ` +
        `:source_reference_${index}, 1)`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_session
       (session_id, account_id, source_kind, source_id, source_reference, revision)
     values ${values}
     returning session_id`,
    parameters,
  };
}

/** One pending entry as the private row stores it; the source line is already encoded. */
interface StoredEntry {
  readonly entryId: string;
  readonly sessionId: string;
  readonly position: number;
  readonly cardId: string | null;
  readonly printingId: string | null;
  readonly finish: ImportEntry['finish'];
  readonly condition: ImportEntry['condition'];
  readonly quantity: number;
  readonly sourceLine: string | null;
  readonly sourceLineKey: string | null;
}

function insertEntriesStatement(accountId: string, entries: readonly StoredEntry[]): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = entries
    .map((entry, index) => {
      parameters[`entry_id_${index}`] = entry.entryId;
      parameters[`session_id_${index}`] = entry.sessionId;
      parameters[`position_${index}`] = entry.position;
      parameters[`card_id_${index}`] = entry.cardId;
      parameters[`printing_id_${index}`] = entry.printingId;
      parameters[`finish_${index}`] = entry.finish;
      parameters[`condition_${index}`] = entry.condition;
      parameters[`quantity_${index}`] = entry.quantity;
      parameters[`source_line_${index}`] = entry.sourceLine;
      parameters[`source_line_key_${index}`] = entry.sourceLineKey;
      return (
        `(:entry_id_${index}, :account_id, :session_id_${index}, 'pending', :position_${index}, ` +
        `:card_id_${index}, :printing_id_${index}, :finish_${index}, :condition_${index}, ` +
        `:quantity_${index}, :source_line_${index}::jsonb, :source_line_key_${index}, 1)`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_entry
       (entry_id, account_id, session_id, state, position, card_id, printing_id, finish, condition,
        quantity, source_line, source_line_key, revision)
     values ${values}
     returning entry_id`,
    parameters,
  };
}

function insertCandidatesStatement(
  accountId: string,
  candidates: readonly {
    readonly entryId: string;
    readonly printingId: string;
    readonly provider: string;
    readonly evidence: string;
  }[],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  const values = candidates
    .map((candidate, index) => {
      parameters[`entry_id_${index}`] = candidate.entryId;
      parameters[`printing_id_${index}`] = candidate.printingId;
      parameters[`provider_${index}`] = candidate.provider;
      parameters[`evidence_${index}`] = candidate.evidence;
      return (
        `(:entry_id_${index}, :account_id, :printing_id_${index}, :provider_${index}, ` +
        `:evidence_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_candidate
       (entry_id, account_id, printing_id, provider, evidence)
     values ${values}
     returning entry_id`,
    parameters,
  };
}

/**
 * Runs one group of bounded inserts and returns the stored identities. A group that does not store
 * exactly the records it carried fails instead of reporting a partly written batch as committed.
 */
async function insertRows(
  statements: UserCardsSqlExecutor,
  groups: readonly InsertedRows[],
  expected: number,
  message: string,
): Promise<readonly string[]> {
  const identities: string[] = [];
  for (const group of groups) {
    const rows = await readRows(
      statements,
      group.statement.statement,
      group.statement.parameters,
      message,
    );
    if (rows.length !== group.count) {
      throw fail(message);
    }
    for (const row of rows) {
      identities.push(textValue(Object.values(row)[0]));
    }
  }
  if (identities.length !== expected) {
    throw fail(message);
  }
  return identities;
}

function insertTags(
  statements: UserCardsSqlExecutor,
  accountId: string,
  tags: readonly { readonly tagId: string; readonly kind: string; readonly label: string }[],
): Promise<readonly string[]> {
  return insertRows(
    statements,
    batches(tags).map((group) => inserted(insertTagsStatement(accountId, group), group.length)),
    tags.length,
    'The migration tags could not be stored.',
  );
}

function insertAssociations(
  statements: UserCardsSqlExecutor,
  accountId: string,
  associations: readonly PlannedAssociation[],
): Promise<readonly string[]> {
  return insertRows(
    statements,
    batches(associations).map((group) =>
      inserted(insertAssociationsStatement(accountId, group), group.length),
    ),
    associations.length,
    'The migration associations could not be stored.',
  );
}

function insertSessions(
  statements: UserCardsSqlExecutor,
  accountId: string,
  sessions: readonly {
    readonly sessionId: string;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly sourceReference: string | null;
  }[],
): Promise<readonly string[]> {
  return insertRows(
    statements,
    batches(sessions).map((group) =>
      inserted(insertSessionsStatement(accountId, group), group.length),
    ),
    sessions.length,
    'The migration imports could not be stored.',
  );
}

/** Stores the plan's pending entries and their recognition alternatives. */
async function insertEntries(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entries: readonly ImportEntry[],
): Promise<void> {
  const stored: StoredEntry[] = entries.map((entry) => ({
    entryId: entry.entryId,
    sessionId: entry.sessionId,
    position: entry.position,
    cardId: entry.cardId,
    printingId: entry.printingId,
    finish: entry.finish,
    condition: entry.condition,
    quantity: entry.quantity,
    sourceLine: entry.sourceLine === null ? null : importSourceLinePayload(entry.sourceLine),
    sourceLineKey: entry.sourceLine === null ? null : migrationSourceLineKey(entry.sourceLine),
  }));
  await insertRows(
    statements,
    chunks(stored, entriesPerStatement).map((group) =>
      inserted(insertEntriesStatement(accountId, group), group.length),
    ),
    stored.length,
    'The migration entries could not be stored.',
  );
  const candidates = entries.flatMap((entry) =>
    entry.candidates.map((candidate) => ({
      entryId: entry.entryId,
      printingId: candidate.printingId,
      provider: candidate.provider,
      evidence: candidate.evidence,
    })),
  );
  if (candidates.length > 0) {
    await insertRows(
      statements,
      batches(candidates).map((group) =>
        inserted(insertCandidatesStatement(accountId, group), group.length),
      ),
      candidates.length,
      'The migration recognition alternatives could not be stored.',
    );
  }
}

/** Writes one batch's records and publishes what it changed, inside the caller's transaction. */
async function writeBatch(
  statements: UserCardsSqlExecutor,
  accountId: string,
  batch: MigrationBatch,
): Promise<string | null> {
  switch (batch.kind) {
    case 'tags': {
      await insertTags(statements, accountId, batch.tags);
      const committedRevision = await advanceRevision(statements, accountId);
      return committedRevision;
    }
    case 'copies': {
      const copies = batch.copies.map((copy) => ({
        copyId: copy.copyId,
        printingId: copy.printingId,
        finish: copy.finish,
        condition: copy.condition,
      }));
      const ownedTag = await ensureOwnedTag(statements, accountId);
      await storeCopiesWithOwnedTag(statements, accountId, ownedTag.tagId, copies);
      // Copy memberships are written before the copy publishes, so a published copy already
      // carries its location instead of publishing a locationless record first.
      await insertAssociations(statements, accountId, batch.memberships);
      const committedRevision = await advanceRevision(statements, accountId);
      return committedRevision;
    }
    case 'associations': {
      await insertAssociations(statements, accountId, batch.associations);
      const committedRevision = await advanceRevision(statements, accountId);
      return committedRevision;
    }
    case 'sessions': {
      await insertSessions(statements, accountId, batch.sessions);
      return null;
    }
    case 'entries': {
      await insertEntries(statements, accountId, batch.entries);
      return null;
    }
  }
}

function insertBatchReceiptStatement(
  accountId: string,
  migrationId: string,
  batch: MigrationBatch,
  publicationPosition: string | null,
): Statement {
  return {
    statement: `insert into usercards_private.migration_batch
       (account_id, migration_id, batch_index, kind, fingerprint, publication_position)
     values (:account_id, :migration_id, :batch_index, :kind, :fingerprint,
             cast(:publication_position as bigint))
     returning batch_index`,
    parameters: {
      account_id: accountId,
      migration_id: migrationId,
      batch_index: batch.index,
      kind: batch.kind,
      fingerprint: batch.fingerprint,
      publication_position: publicationPosition,
    },
  };
}

async function recordBatch(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
  batch: MigrationBatch,
  publicationPosition: string | null,
): Promise<void> {
  const request = insertBatchReceiptStatement(accountId, migrationId, batch, publicationPosition);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The migration batch could not be recorded.',
  );
  if (rows.length !== 1) {
    throw fail('UserCards did not record the migration batch.');
  }
}

async function readBatchReceipt(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
  batchIndex: number,
): Promise<{ readonly fingerprint: string; readonly publicationPosition: string | null } | null> {
  const rows = await readRows(
    statements,
    `select fingerprint, publication_position::text as publication_position
       from usercards_private.migration_batch
      where account_id = :account_id and migration_id = :migration_id
        and batch_index = :batch_index`,
    { account_id: accountId, migration_id: migrationId, batch_index: batchIndex },
    'The recorded migration batch could not be read.',
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        fingerprint: textValue(row.fingerprint),
        publicationPosition: nullablePosition(row.publication_position),
      };
}

/** Marks the migration complete and reports the position of its last query-visible batch. */
async function completeMigration(
  statements: UserCardsSqlExecutor,
  accountId: string,
  migrationId: string,
): Promise<MigrationProgress> {
  const rows = await readRows(
    statements,
    `update usercards_private.migration
        set state = 'completed',
            publication_position = (select max(batch.publication_position)
                                      from usercards_private.migration_batch as batch
                                     where batch.account_id = :account_id
                                       and batch.migration_id = :migration_id),
            completed_at = coalesce(completed_at, now()),
            updated_at = now()
      where account_id = :account_id and migration_id = :migration_id
      returning state, publication_position::text as publication_position`,
    { account_id: accountId, migration_id: migrationId },
    'The migration could not be completed.',
  );
  const row = rows[0];
  if (row === undefined || textValue(row.state) !== 'completed') {
    throw fail('UserCards did not complete the migration.');
  }
  return {
    state: 'completed',
    batches: await readBatchReceipts(statements, accountId, migrationId),
    publicationPosition: nullablePosition(row.publication_position),
  };
}

function copiesPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select ${copyPayloadSql} as payload
       from usercards_private.copy
      where account_id = :account_id
      order by copy_id
      limit :limit offset :offset`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function tagsPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select ${tagPayloadSql} as payload
       from usercards_private.tag
      where account_id = :account_id and not system
      order by tag_id
      limit :limit offset :offset`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function associationsPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select ${associationPayloadSql} as payload
       from usercards_private.association
      where account_id = :account_id
        and tag_id in (select tag_id
                         from usercards_private.tag
                        where account_id = :account_id and not system)
      order by association_id
      limit :limit offset :offset`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function ownedCopiesPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select association.target_id as copy_id
       from usercards_private.association as association
      where association.account_id = :account_id
        and association.target_level = 'copy'
        and association.tag_id in (select tag_id
                                     from usercards_private.tag
                                    where account_id = :account_id and system)
      order by association.target_id
      limit :limit offset :offset`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function sessionsPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select to_jsonb(page)::text as payload
       from (${sessionSelectSql}
${sessionGroupBySql}
       order by session.session_id
       limit :limit offset :offset) as page`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function entriesPageStatement(accountId: string, limit: number, offset: number): Statement {
  return {
    statement: `select 'entry' as row_kind,
  (row_number() over (order by entry.session_id, entry.position))::int as row_position,
  ${importEntryPayloadSql} as payload
from (select entry_id, session_id, position, state, card_id, printing_id, finish, condition,
             quantity, source_line, revision
        from usercards_private.import_entry
       where account_id = :account_id and state = 'pending'
       order by session_id, position
       limit :limit offset :offset) as entry
union all
select 'candidate' as row_kind,
  (row_number() over (order by candidate.entry_id, candidate.printing_id, candidate.provider,
                      candidate.evidence))::int as row_position,
  ${importCandidatePayloadSql} as payload
from (select candidate.entry_id, candidate.printing_id, candidate.provider, candidate.evidence
        from usercards_private.import_candidate as candidate
       where candidate.account_id = :account_id
         and candidate.entry_id in (select entry_id
                                      from usercards_private.import_entry
                                     where account_id = :account_id and state = 'pending'
                                     order by session_id, position
                                     limit :limit offset :offset)) as candidate
order by row_kind, row_position`,
    parameters: { account_id: accountId, limit, offset },
  };
}

function archivePageStatement(
  accountId: string,
  migrationId: string,
  limit: number,
  offset: number,
): Statement {
  return {
    statement: `select content
       from usercards_private.migration_archive
      where account_id = :account_id and migration_id = :migration_id
      order by chunk_index
      limit :limit offset :offset`,
    parameters: { account_id: accountId, migration_id: migrationId, limit, offset },
  };
}

/** Runs one bounded page statement until it returns a short page. */
async function pages<TRecord>(
  statements: UserCardsSqlExecutor,
  build: (limit: number, offset: number) => Statement,
  limit: number,
  message: string,
  read: (rows: readonly UserCardsSqlRow[]) => readonly TRecord[],
): Promise<readonly TRecord[]> {
  const records: TRecord[] = [];
  for (let offset = 0; ; offset += limit) {
    const request = build(limit, offset);
    const rows = await readRows(statements, request.statement, request.parameters, message);
    records.push(...read(rows));
    if (rows.length < limit) {
      return records;
    }
  }
}

/** Reads and writes the private migration records of one account. */
export function createPostgresMigrationStore(sql: UserCardsSqlTransactor): MigrationStore {
  return {
    async recorded(accountId, record): Promise<MigrationRecordedOutcome | null> {
      return inTransaction(
        sql,
        async (statements): Promise<MigrationRecordedOutcome | null> => {
          const migration = await readRecordedMigration(statements, accountId, record.migrationId);
          if (migration === null) {
            return null;
          }
          if (
            migration.planDigest !== record.planDigest ||
            migration.sourceDigest !== record.sourceDigest ||
            migration.batchCount !== record.batchCount
          ) {
            return { outcome: 'conflict', reason: 'recorded-input' };
          }
          return {
            outcome: 'recorded',
            progress: {
              state: migration.state,
              batches: await readBatchReceipts(statements, accountId, record.migrationId),
              publicationPosition: migration.publicationPosition,
            },
          };
        },
        'The recorded migration could not be read.',
      );
    },

    async start(accountId, record, archive): Promise<MigrationStartOutcome> {
      return inTransaction(
        sql,
        async (statements): Promise<MigrationStartOutcome> => {
          await lockAccount(statements, accountId);
          const migration = await readRecordedMigration(statements, accountId, record.migrationId);
          if (migration !== null) {
            if (
              migration.planDigest !== record.planDigest ||
              migration.sourceDigest !== record.sourceDigest ||
              migration.batchCount !== record.batchCount
            ) {
              return { outcome: 'conflict', reason: 'recorded-input' };
            }
            return {
              outcome: 'recorded',
              progress: {
                state: migration.state,
                batches: await readBatchReceipts(statements, accountId, record.migrationId),
                publicationPosition: migration.publicationPosition,
              },
            };
          }
          if (await accountHoldsRecords(statements, accountId)) {
            return { outcome: 'conflict', reason: 'nonempty-account' };
          }
          await insertMigration(statements, accountId, record);
          await insertArchive(statements, accountId, record.migrationId, archive);
          return {
            outcome: 'started',
            progress: { state: 'loading', batches: [], publicationPosition: null },
          };
        },
        'The migration could not be started.',
      );
    },

    async applyBatch(accountId, migrationId, batch): Promise<MigrationBatchOutcome> {
      return inTransaction(
        sql,
        async (statements): Promise<MigrationBatchOutcome> => {
          await lockAccount(statements, accountId);
          const migration = await readRecordedMigration(statements, accountId, migrationId);
          if (migration === null) {
            throw new UserCardsError('conflict', 'The recorded migration is not available.');
          }
          const receipt = await readBatchReceipt(statements, accountId, migrationId, batch.index);
          if (receipt !== null) {
            if (receipt.fingerprint !== batch.fingerprint) {
              return { outcome: 'conflict' };
            }
            return { outcome: 'replayed', publicationPosition: receipt.publicationPosition };
          }
          if (migration.state !== 'loading') {
            // The migration completed without this batch, so the presented plan is not it.
            return { outcome: 'conflict' };
          }
          const publicationPosition = await writeBatch(statements, accountId, batch);
          await recordBatch(statements, accountId, migrationId, batch, publicationPosition);
          return { outcome: 'applied', publicationPosition };
        },
        'The migration batch could not be committed.',
      );
    },

    async complete(accountId, migrationId): Promise<MigrationProgress> {
      return inTransaction(
        sql,
        async (statements) => {
          await lockAccount(statements, accountId);
          const migration = await readRecordedMigration(statements, accountId, migrationId);
          if (migration === null) {
            throw new UserCardsError('conflict', 'The recorded migration is not available.');
          }
          return completeMigration(statements, accountId, migrationId);
        },
        'The migration could not be completed.',
      );
    },

    async readReadback(accountId): Promise<MigrationReadbackOutcome> {
      return inTransaction(
        sql,
        async (statements): Promise<MigrationReadbackOutcome> => {
          const migrations = await readRows(
            statements,
            `select migration_id, state
               from usercards_private.migration
              where account_id = :account_id
              order by migration_id
              limit 2`,
            { account_id: accountId },
            'The recorded migration could not be read.',
          );
          if (migrations.length === 0) {
            return { outcome: 'absent' };
          }
          if (migrations.length > 1) {
            throw fail('The account records more than one migration.');
          }
          const migration = migrations[0] as UserCardsSqlRow;
          const migrationId = textValue(migration.migration_id);
          if (textValue(migration.state) !== 'completed') {
            return { outcome: 'incomplete' };
          }
          const copies = await pages(
            statements,
            (limit, offset) => copiesPageStatement(accountId, limit, offset),
            readbackRowsPerRead,
            'The target copies could not be read.',
            copiesFromRows,
          );
          const tags = await pages(
            statements,
            (limit, offset) => tagsPageStatement(accountId, limit, offset),
            readbackRowsPerRead,
            'The target tags could not be read.',
            tagsFromRows,
          );
          const associations = await pages(
            statements,
            (limit, offset) => associationsPageStatement(accountId, limit, offset),
            readbackRowsPerRead,
            'The target associations could not be read.',
            associationsFromRows,
          );
          const ownedCopyIds = await pages(
            statements,
            (limit, offset) => ownedCopiesPageStatement(accountId, limit, offset),
            readbackRowsPerRead,
            'The target ownership records could not be read.',
            (rows) => rows.map((owned) => textValue(owned.copy_id)),
          );
          const sessions = await pages(
            statements,
            (limit, offset) => sessionsPageStatement(accountId, limit, offset),
            readbackRowsPerRead,
            'The target imports could not be read.',
            (rows) => rows.map((session) => importSessionFromRow(session)),
          );
          const pending = await pages(
            statements,
            (limit, offset) => entriesPageStatement(accountId, limit, offset),
            entriesPerRead,
            'The target pending entries could not be read.',
            (rows) => {
              const grouped = groupRows(rows, ['entry', 'candidate'] as const);
              return importEntriesFromRows(grouped.entry, grouped.candidate);
            },
          );
          const archive = await pages(
            statements,
            (limit, offset) => archivePageStatement(accountId, migrationId, limit, offset),
            archiveChunksPerRead,
            'The recorded migration archive could not be read.',
            (rows) => rows.map((chunk) => textValue(chunk.content)),
          );
          return {
            outcome: 'read',
            readback: {
              accountId,
              copies,
              ownedCopyIds,
              tags,
              associations,
              sessions,
              pending,
              archiveDigest: migrationArchiveDigest(archive.join('')),
            },
          };
        },
        'The migration readback could not be read.',
      );
    },
  };
}

function chunks<T>(records: readonly T[], size: number): readonly (readonly T[])[] {
  const grouped: T[][] = [];
  for (let start = 0; start < records.length; start += size) {
    grouped.push(records.slice(start, start + size));
  }
  return grouped;
}
