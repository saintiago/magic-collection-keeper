import { randomUUID } from 'node:crypto';

import type { UserCardsSqlTransactor, UserCardsSqlValue } from './executor.js';
import {
  associationFromRow,
  associationPayloadSql,
  associationsFromRows,
  copyFromRow,
  copyPayloadSql,
  tagFromRow,
  tagPayloadSql,
  tagsFromRows,
} from './rows.js';
import {
  groupRows,
  inTransaction,
  placeholdersFor,
  readRows,
  revisionBranchSql,
  revisionFromPayload,
  revisionFromRow,
  revisionStatement,
} from './sql.js';
import type {
  AssociationCorrection,
  AssociationCorrectionOutcome,
  AssociationInsertOutcome,
  AssociationRemovalOutcome,
  AssociationsData,
  CopyLocationChange,
  CopyLocationOutcome,
  NewAssociation,
  NewTag,
  OrganizationStore,
  TagChangeData,
  TagCorrection,
  TagCorrectionOutcome,
  TagsData,
} from './store.js';

function readTagsStatement(
  accountId: string,
  tagIds: readonly string[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  const branches = [revisionBranchSql()];
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  if (tagIds.length > 0) {
    const references = placeholdersFor(tagIds, 'tag');
    Object.assign(parameters, references.parameters);
    branches.push(`select 'tag' as row_kind,
  (row_number() over (order by entry.tag_id))::int as row_position,
  to_jsonb(entry)::text as payload
from (select tag_id, kind, label, system, revision
      from usercards_private.tag
      where account_id = :account_id and tag_id in (${references.list})) as entry`);
  }
  return {
    statement: `${branches.join('\nunion all\n')}
order by row_kind, row_position`,
    parameters,
  };
}

/** Boundary-tagged list of one account's tags, ordered by stable tag identity. */
function listTagsStatement(
  accountId: string,
  offset: number,
  limit: number,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `${revisionBranchSql()}
union all
select 'tag' as row_kind,
  (row_number() over (order by entry.tag_id))::int as row_position,
  to_jsonb(entry)::text as payload
from (select tag_id, kind, label, system, revision
      from usercards_private.tag
      where account_id = :account_id
      order by tag_id
      limit :limit offset :offset) as entry
order by row_kind, row_position`,
    parameters: { account_id: accountId, offset, limit },
  };
}

function insertTagStatement(
  accountId: string,
  tag: NewTag,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `insert into usercards_private.tag (tag_id, account_id, kind, label, system, revision)
     values (:tag_id, :account_id, :kind, :label, false, 1)
     returning ${tagPayloadSql} as payload`,
    parameters: {
      tag_id: tag.tagId,
      account_id: accountId,
      kind: tag.kind,
      label: tag.label,
    },
  };
}

function correctTagStatement(
  accountId: string,
  correction: TagCorrection,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `update usercards_private.tag as target
   set label = :label,
       revision = target.revision + 1,
       updated_at = now()
 where target.tag_id = :tag_id
   and target.account_id = :account_id
   and target.revision = :expected_revision
   and target.system = false
 returning ${tagPayloadSql} as payload`,
    parameters: {
      tag_id: correction.tagId,
      account_id: accountId,
      expected_revision: correction.expectedRevision,
      label: correction.label,
    },
  };
}

function readAssociationsStatement(
  accountId: string,
  associationIds: readonly string[],
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  const branches = [revisionBranchSql()];
  const parameters: Record<string, UserCardsSqlValue> = { account_id: accountId };
  if (associationIds.length > 0) {
    const references = placeholdersFor(associationIds, 'association');
    Object.assign(parameters, references.parameters);
    branches.push(`select 'association' as row_kind,
  (row_number() over (order by entry.association_id))::int as row_position,
  to_jsonb(entry)::text as payload
from (select association_id, tag_id, target_level, target_id, quantity, revision
      from usercards_private.association
      where account_id = :account_id and association_id in (${references.list})) as entry`);
  }
  return {
    statement: `${branches.join('\nunion all\n')}
order by row_kind, row_position`,
    parameters,
  };
}

function insertAssociationStatement(
  accountId: string,
  association: NewAssociation,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `insert into usercards_private.association
       (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
     values (:association_id, :account_id, :tag_id, :tag_kind, :target_level, :target_id,
             :quantity, 1)
     on conflict do nothing
     returning ${associationPayloadSql} as payload`,
    parameters: {
      association_id: association.associationId,
      account_id: accountId,
      tag_id: association.tagId,
      tag_kind: association.tagKind,
      target_level: association.targetLevel,
      target_id: association.targetId,
      quantity: association.quantity,
    },
  };
}

/**
 * A change keeps the association identity and refuses to create a second association of the same
 * tag for the same target, so a refined association replaces its own target instead of doubling it.
 */
function correctAssociationStatement(
  accountId: string,
  correction: AssociationCorrection,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `update usercards_private.association as target
   set target_level = :target_level,
       target_id = :target_id,
       quantity = :quantity,
       revision = target.revision + 1,
       updated_at = now()
 where target.association_id = :association_id
   and target.account_id = :account_id
   and target.revision = :expected_revision
   and not exists (
     select 1
       from usercards_private.association as other
      where other.account_id = target.account_id
        and other.tag_id = target.tag_id
        and other.target_level = :target_level
        and other.target_id = :target_id
        and other.association_id <> target.association_id)
 returning ${associationPayloadSql} as payload`,
    parameters: {
      association_id: correction.associationId,
      account_id: accountId,
      expected_revision: correction.expectedRevision,
      target_level: correction.targetLevel,
      target_id: correction.targetId,
      quantity: correction.quantity,
    },
  };
}

function removeAssociationStatement(
  accountId: string,
  associationId: string,
  expectedRevision: number,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `delete from usercards_private.association as target
 where target.association_id = :association_id
   and target.account_id = :account_id
   and target.revision = :expected_revision
 returning target.association_id as association_id`,
    parameters: {
      association_id: associationId,
      account_id: accountId,
      expected_revision: expectedRevision,
    },
  };
}

/** Advances the copy revision as part of its location change, guarded by the revision it was read at. */
function copyForLocationMoveStatement(
  accountId: string,
  change: CopyLocationChange,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `update usercards_private.copy as target
   set revision = target.revision + 1,
       updated_at = now()
 where target.copy_id = :copy_id
   and target.account_id = :account_id
   and target.revision = :expected_revision
 returning ${copyPayloadSql} as payload`,
    parameters: {
      copy_id: change.copyId,
      account_id: accountId,
      expected_revision: change.expectedRevision,
    },
  };
}

/**
 * Assigns the copy's single location membership. The partial unique index on copy-targeted
 * location associations infers the conflict, so a move replaces the previous location in the same
 * statement instead of leaving the copy in two locations (docs/user-cards.md#records-and-associations).
 */
function assignLocationStatement(
  accountId: string,
  copyId: string,
  locationTagId: string,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `insert into usercards_private.association as stored
       (association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision)
     values (:association_id, :account_id, :tag_id, 'location', 'copy', :copy_id, null, 1)
     on conflict (account_id, target_id) where target_level = 'copy' and tag_kind = 'location'
     do update set tag_id = excluded.tag_id,
                   revision = stored.revision + 1,
                   updated_at = now()
     returning ${associationPayloadSql} as payload`,
    parameters: {
      association_id: randomUUID(),
      account_id: accountId,
      tag_id: locationTagId,
      copy_id: copyId,
    },
  };
}

function clearLocationStatement(
  accountId: string,
  copyId: string,
): { statement: string; parameters: Record<string, UserCardsSqlValue> } {
  return {
    statement: `delete from usercards_private.association
 where account_id = :account_id
   and tag_kind = 'location'
   and target_level = 'copy'
   and target_id = :copy_id`,
    parameters: { account_id: accountId, copy_id: copyId },
  };
}

/** Reads and writes the private tags, associations and copy locations of one account. */
export function createPostgresOrganizationStore(sql: UserCardsSqlTransactor): OrganizationStore {
  return {
    async readTags(accountId, tagIds): Promise<TagsData> {
      const request = readTagsStatement(accountId, tagIds);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private tags could not be read.',
        ),
        ['revision', 'tag'] as const,
      );
      return {
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
        tags: tagsFromRows(rows.tag),
      };
    },

    async listTags(accountId, offset, limit): Promise<TagsData> {
      const request = listTagsStatement(accountId, offset, limit);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private tags could not be read.',
        ),
        ['revision', 'tag'] as const,
      );
      return {
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
        tags: tagsFromRows(rows.tag),
      };
    },

    async createTag(accountId, tag): Promise<TagChangeData> {
      return inTransaction(
        sql,
        async (statements) => {
          const insert = insertTagStatement(accountId, tag);
          const rows = await readRows(
            statements,
            insert.statement,
            insert.parameters,
            'The tag could not be stored.',
          );
          const publication = revisionStatement(accountId);
          const revisionRow = await readRows(
            statements,
            publication.statement,
            publication.parameters,
            'The private-data revision could not be advanced.',
          );
          return {
            privateRevision: revisionFromRow(revisionRow[0]),
            tag: tagFromRow(rows[0]),
          };
        },
        'The tag could not be committed.',
      );
    },

    async correctTag(accountId, correction): Promise<TagCorrectionOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const update = correctTagStatement(accountId, correction);
          const rows = await readRows(
            statements,
            update.statement,
            update.parameters,
            'The tag rename could not be stored.',
          );
          const row = rows[0];
          if (row !== undefined) {
            const publication = revisionStatement(accountId);
            const revisionRow = await readRows(
              statements,
              publication.statement,
              publication.parameters,
              'The private-data revision could not be advanced.',
            );
            return {
              outcome: 'updated' as const,
              privateRevision: revisionFromRow(revisionRow[0]),
              tag: tagFromRow(row),
            };
          }
          const existing = await readRows(
            statements,
            `select system, revision from usercards_private.tag
              where tag_id = :tag_id and account_id = :account_id`,
            { tag_id: correction.tagId, account_id: accountId },
            'The tag could not be read.',
          );
          const stored = existing[0];
          if (stored === undefined) {
            return { outcome: 'missing' as const };
          }
          return stored.system === true
            ? { outcome: 'system' as const }
            : { outcome: 'conflict' as const };
        },
        'The tag rename could not be committed.',
      );
    },

    async readAssociations(accountId, associationIds): Promise<AssociationsData> {
      const request = readAssociationsStatement(accountId, associationIds);
      const rows = groupRows(
        await readRows(
          sql,
          request.statement,
          request.parameters,
          'The private associations could not be read.',
        ),
        ['revision', 'association'] as const,
      );
      return {
        privateRevision: revisionFromPayload(rows.revision[0]?.payload),
        associations: associationsFromRows(rows.association),
      };
    },

    async insertAssociation(accountId, association): Promise<AssociationInsertOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const insert = insertAssociationStatement(accountId, association);
          const rows = await readRows(
            statements,
            insert.statement,
            insert.parameters,
            'The association could not be stored.',
          );
          const row = rows[0];
          if (row === undefined) {
            return { outcome: 'conflict' as const };
          }
          const publication = revisionStatement(accountId);
          const revisionRow = await readRows(
            statements,
            publication.statement,
            publication.parameters,
            'The private-data revision could not be advanced.',
          );
          return {
            outcome: 'inserted' as const,
            privateRevision: revisionFromRow(revisionRow[0]),
            association: associationFromRow(row),
          };
        },
        'The association could not be committed.',
      );
    },

    async correctAssociation(accountId, correction): Promise<AssociationCorrectionOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const update = correctAssociationStatement(accountId, correction);
          const rows = await readRows(
            statements,
            update.statement,
            update.parameters,
            'The association change could not be stored.',
          );
          const row = rows[0];
          if (row !== undefined) {
            const publication = revisionStatement(accountId);
            const revisionRow = await readRows(
              statements,
              publication.statement,
              publication.parameters,
              'The private-data revision could not be advanced.',
            );
            return {
              outcome: 'updated' as const,
              privateRevision: revisionFromRow(revisionRow[0]),
              association: associationFromRow(row),
            };
          }
          const existing = await readRows(
            statements,
            `select revision from usercards_private.association
              where association_id = :association_id and account_id = :account_id`,
            { association_id: correction.associationId, account_id: accountId },
            'The association could not be read.',
          );
          const stored = existing[0];
          if (stored === undefined) {
            return { outcome: 'missing' as const };
          }
          const storedRevision =
            typeof stored.revision === 'string' ? Number(stored.revision) : stored.revision;
          return storedRevision === correction.expectedRevision
            ? { outcome: 'duplicate' as const }
            : { outcome: 'conflict' as const };
        },
        'The association change could not be committed.',
      );
    },

    async removeAssociation(
      accountId,
      associationId,
      expectedRevision,
    ): Promise<AssociationRemovalOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const removal = removeAssociationStatement(accountId, associationId, expectedRevision);
          const rows = await readRows(
            statements,
            removal.statement,
            removal.parameters,
            'The association could not be removed.',
          );
          if (rows[0] !== undefined) {
            const publication = revisionStatement(accountId);
            const revisionRow = await readRows(
              statements,
              publication.statement,
              publication.parameters,
              'The private-data revision could not be advanced.',
            );
            return {
              outcome: 'removed' as const,
              privateRevision: revisionFromRow(revisionRow[0]),
              associationId,
            };
          }
          const existing = await readRows(
            statements,
            `select revision from usercards_private.association
              where association_id = :association_id and account_id = :account_id`,
            { association_id: associationId, account_id: accountId },
            'The association could not be read.',
          );
          return existing[0] === undefined
            ? { outcome: 'missing' as const }
            : { outcome: 'conflict' as const };
        },
        'The association removal could not be committed.',
      );
    },

    async moveCopyLocation(accountId, change): Promise<CopyLocationOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const copyUpdate = copyForLocationMoveStatement(accountId, change);
          const copyRows = await readRows(
            statements,
            copyUpdate.statement,
            copyUpdate.parameters,
            'The copy location change could not be stored.',
          );
          const copyRow = copyRows[0];
          if (copyRow === undefined) {
            const existing = await readRows(
              statements,
              `select revision from usercards_private.copy
                where copy_id = :copy_id and account_id = :account_id`,
              { copy_id: change.copyId, account_id: accountId },
              'The copy could not be read.',
            );
            return existing[0] === undefined
              ? { outcome: 'missing-copy' as const }
              : { outcome: 'conflict' as const };
          }
          const location =
            change.locationTagId === null
              ? clearLocationStatement(accountId, change.copyId)
              : assignLocationStatement(accountId, change.copyId, change.locationTagId);
          const locationRows = await readRows(
            statements,
            location.statement,
            location.parameters,
            'The copy location could not be stored.',
          );
          const publication = revisionStatement(accountId);
          const revisionRow = await readRows(
            statements,
            publication.statement,
            publication.parameters,
            'The private-data revision could not be advanced.',
          );
          return {
            outcome: 'moved' as const,
            privateRevision: revisionFromRow(revisionRow[0]),
            copy: copyFromRow(copyRow),
            location: locationRows[0] === undefined ? null : associationFromRow(locationRows[0]),
          };
        },
        'The location move could not be committed.',
      );
    },
  };
}
