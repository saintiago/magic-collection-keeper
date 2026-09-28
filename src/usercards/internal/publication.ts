/**
 * Atomic publication of one query-visible mutation (docs/user-cards.md#query-surface).
 *
 * Every mutation that changes the published records advances the account's private revision and
 * appends the changes of the records it touched, then the revision that completes them, in the
 * same transaction as the authoritative rows: a failed or interrupted mutation leaves the
 * previous publication exactly as it was, and a consumer never observes half a confirmation or
 * location move. The record changes are read through the same account-scoped relations consumers
 * read — the account is bound inside the mutation's transaction — so the record a change carries
 * is the record the query surface publishes. The revision marker is written last, so its position
 * is both the position the mutation reports and the position a consumer resumes from, and
 * retention drops only publications older than the declared history.
 *
 * Operations that change pending review only publish no record and no revision: pending entries
 * are not ordinary searchable ownership data (docs/user-cards.md#import-and-capture-state).
 */

import { UserCardsError } from './errors.js';
import type { UserCardsSqlExecutor, UserCardsSqlValue } from './executor.js';
import { USERCARDS_PUBLICATION_LIMITS, changePositionSchema } from './query-publication.js';
import { USERCARDS_ACCOUNT_SCOPE_SQL, usercardsQuerySchema } from './schema.js';
import { batches, placeholdersFor, readRows, revisionFromRow, revisionStatement } from './sql.js';

/** The record identities one query-visible mutation changed. */
export interface PublishedChanges {
  readonly copies?: readonly string[];
  readonly tags?: readonly string[];
  /** Association identities the mutation inserted or corrected. */
  readonly associations?: readonly string[];
  /** Association identities the mutation removed. */
  readonly removedAssociations?: readonly string[];
}

/** What one published mutation committed: its account-scoped revision and its position. */
export interface MutationPublication {
  /** Account-scoped private-data revision the mutation advanced to. */
  readonly revision: string;
  /** Position of the revision that completes the mutation. */
  readonly position: string;
}

/** The published relation and identity column each record kind is read and carried under. */
const publishedRelations = {
  copy: { relation: `${usercardsQuerySchema}.copies`, identity: 'copy_id' },
  tag: { relation: `${usercardsQuerySchema}.tags`, identity: 'tag_id' },
  association: {
    relation: `${usercardsQuerySchema}.associations`,
    identity: 'association_id',
  },
} as const;

type RecordKind = keyof typeof publishedRelations;

/**
 * Publishes one mutation: its record changes carry the revision that completed them, and the
 * revision marker written after them is the position the caller reports and a consumer resumes
 * from. The caller applies the authoritative writes first, inside the same transaction.
 */
export async function publishMutation(
  statements: UserCardsSqlExecutor,
  accountId: string,
  changes: PublishedChanges,
): Promise<MutationPublication> {
  const advance = revisionStatement(accountId);
  const revision = revisionFromRow(
    (
      await readRows(
        statements,
        advance.statement,
        advance.parameters,
        'The private-data revision could not be advanced.',
      )
    )[0],
  );
  await bindAccountScope(statements, accountId);
  await publishRecords(statements, accountId, revision, 'copy', changes.copies ?? []);
  await publishRecords(statements, accountId, revision, 'tag', changes.tags ?? []);
  await publishRecords(statements, accountId, revision, 'association', changes.associations ?? []);
  await publishRemovals(statements, accountId, revision, changes.removedAssociations ?? []);
  const marker = await readRows(
    statements,
    revisionMarkerStatement,
    { account_id: accountId, revision },
    'The publication position could not be recorded.',
  );
  const position = positionFromRow(marker[0]);
  await readRows(
    statements,
    retentionStatement,
    {
      account_id: accountId,
      retained_revisions: USERCARDS_PUBLICATION_LIMITS.retainedRevisions,
    },
    'The publication history could not be retained.',
  );
  return { revision, position };
}

/**
 * Reads the changed records through the published relation and appends one upsert change per
 * identity. The statement is bounded like every other private write, and a relation that does not
 * return every requested record fails instead of publishing an incomplete mutation.
 */
async function publishRecords(
  statements: UserCardsSqlExecutor,
  accountId: string,
  revision: string,
  kind: RecordKind,
  identities: readonly string[],
): Promise<void> {
  const { relation, identity } = publishedRelations[kind];
  for (const batch of batches(identities)) {
    const references = placeholdersFor(batch, 'published');
    const parameters: Record<string, UserCardsSqlValue> = {
      account_id: accountId,
      revision,
      ...references.parameters,
    };
    const rows = await readRows(
      statements,
      `insert into usercards_private.publication (
         account_id, revision, kind, record_identity, removed, record
       )
       select :account_id, cast(:revision as integer), '${kind}', published.${identity}, false,
              to_jsonb(published)
         from ${relation} as published
        where published.${identity} in (${references.list})
       on conflict (account_id, revision, kind, record_identity)
         do update set record = excluded.record
       returning record_identity`,
      parameters,
      'The changed records could not be published.',
    );
    if (rows.length !== batch.length) {
      throw new UserCardsError('unavailable', 'UserCards did not publish every changed record.');
    }
  }
}

/** Appends one explicit removal per identity; a removal carries no record, only its identity. */
async function publishRemovals(
  statements: UserCardsSqlExecutor,
  accountId: string,
  revision: string,
  identities: readonly string[],
): Promise<void> {
  for (const batch of batches(identities)) {
    const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId, revision };
    const values = batch
      .map((identity, index) => {
        parameters[`removed_${index}`] = identity;
        return `(:account_id, cast(:revision as integer), 'association', :removed_${index}, true, null)`;
      })
      .join(',\n       ');
    const rows = await readRows(
      statements,
      `insert into usercards_private.publication (
         account_id, revision, kind, record_identity, removed, record
       )
       values ${values}
       on conflict (account_id, revision, kind, record_identity)
         do update set removed = true, record = null
       returning record_identity`,
      parameters,
      'The removed records could not be published.',
    );
    if (rows.length !== batch.length) {
      throw new UserCardsError('unavailable', 'UserCards did not publish every removed record.');
    }
  }
}

/**
 * The revision that completes a mutation. It is written after every record change of the
 * mutation, so its position is the mutation's publication position and a consumer that applied it
 * holds the complete mutation.
 */
const revisionMarkerStatement = `insert into usercards_private.publication (
    account_id, revision, kind, record_identity, removed, record
  )
  values (:account_id, cast(:revision as integer), 'revision', null, false, null)
  returning position::text as position`;

/**
 * Retains the declared number of newest publications of one account and records the position
 * below which the history was dropped, so an older resume fails explicitly instead of skipping
 * changes.
 */
const retentionStatement = `with boundary as (
  select marker.position
    from (
      select position, row_number() over (order by position desc) as marker_rank
        from usercards_private.publication
       where account_id = :account_id and kind = 'revision'
    ) as marker
   where marker.marker_rank = :retained_revisions
),
expired as (
  delete from usercards_private.publication
   where account_id = :account_id
     and position < (select position from boundary)
  returning position
)
update usercards_private.account_state
   set expired_below = greatest(expired_below, (select position from boundary))
 where account_id = :account_id
   and (select position from boundary) is not null
returning expired_below::text as expired_below`;

/** Binds the account inside the mutation's transaction, so the published relations fail closed. */
async function bindAccountScope(
  statements: UserCardsSqlExecutor,
  accountId: string,
): Promise<void> {
  await readRows(
    statements,
    USERCARDS_ACCOUNT_SCOPE_SQL,
    { account_id: accountId },
    'The publication account scope could not be bound.',
  );
}

function positionFromRow(row: Readonly<Record<string, UserCardsSqlValue>> | undefined): string {
  const parsed = changePositionSchema.safeParse(row?.position);
  if (!parsed.success || parsed.data === '0') {
    throw new UserCardsError('unavailable', 'UserCards did not report the publication position.');
  }
  return parsed.data;
}
