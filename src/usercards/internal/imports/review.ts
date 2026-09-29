/** review persistence for private imports. See docs/user-cards.md#internal-design. */
import { UserCardsError } from '../errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from '../executor.js';
import { USERCARDS_LIMITS } from '../model.js';
import { inTransaction, readRows } from '../sql.js';
import type {
  CandidateAttachment,
  CandidateAttachmentOutcome,
  ImportEntryCorrection,
  ImportEntryCorrectionOutcome,
  ImportEntryDiscardOutcome,
  ImportSessionDiscardOutcome,
  ImportStore,
} from '../store.js';
import {
  advanceRevision,
  bumpSessionStatement,
  currentRevision,
  integerValue,
  lockSessionStatement,
  readEntry,
  requireEntry,
  requireSession,
  textValue,
  type Statement,
} from './session-state.js';

/** Resolves an entry's session and locks it, so its mutations serialize with the whole import. */
function lockEntrySessionStatement(accountId: string, entryId: string): Statement {
  return {
    statement: `select session.account_id, session.session_id
     from usercards_private.import_session as session
     join usercards_private.import_entry as entry
       on entry.account_id = session.account_id
      and entry.session_id = session.session_id
    where session.account_id = :account_id and entry.entry_id = :entry_id
    for update of session`,
    parameters: { account_id: accountId, entry_id: entryId },
  };
}

function correctEntryStatement(accountId: string, correction: ImportEntryCorrection): Statement {
  return {
    statement: `update usercards_private.import_entry as target
     set card_id = :card_id,
         printing_id = :printing_id,
         finish = :finish,
         condition = :condition,
         quantity = :quantity,
         revision = target.revision + 1,
         updated_at = now()
    where target.account_id = :account_id
      and target.entry_id = :entry_id
      and target.state = 'pending'
      and target.revision = :expected_revision
    returning target.entry_id`,
    parameters: {
      account_id: accountId,
      entry_id: correction.entryId,
      expected_revision: correction.expectedRevision,
      card_id: correction.cardId,
      printing_id: correction.printingId,
      finish: correction.finish,
      condition: correction.condition,
      quantity: correction.quantity,
    },
  };
}

function insertCandidateStatement(
  accountId: string,
  entryId: string,
  candidates: CandidateAttachment['candidates'],
): Statement {
  const parameters: Record<string, UserCardsSqlValue> = {
    account_id: accountId,
    entry_id: entryId,
  };
  const values = candidates
    .map((candidate, index) => {
      parameters[`printing_id_${index}`] = candidate.printingId;
      parameters[`provider_${index}`] = candidate.provider;
      parameters[`evidence_${index}`] = candidate.evidence;
      return (
        `(:entry_id, :account_id, :printing_id_${index}, :provider_${index}, ` +
        `:evidence_${index})`
      );
    })
    .join(',\n       ');
  return {
    statement: `insert into usercards_private.import_candidate
       (entry_id, account_id, printing_id, provider, evidence)
     values ${values}
     on conflict do nothing
     returning printing_id`,
    parameters,
  };
}

function discardEntryStatement(
  accountId: string,
  entryId: string,
  expectedRevision: number,
): Statement {
  return {
    statement: `update usercards_private.import_entry as target
     set state = 'discarded',
         revision = target.revision + 1,
         updated_at = now()
    where target.account_id = :account_id
      and target.entry_id = :entry_id
      and target.state = 'pending'
      and target.revision = :expected_revision
    returning target.entry_id`,
    parameters: {
      account_id: accountId,
      entry_id: entryId,
      expected_revision: expectedRevision,
    },
  };
}

function discardPendingEntriesStatement(accountId: string, sessionId: string): Statement {
  return {
    statement: `with discarded as (update usercards_private.import_entry
     set state = 'discarded',
         revision = revision + 1,
         updated_at = now()
    where account_id = :account_id and session_id = :session_id and state = 'pending'
    returning 1) select count(*)::int as count from discarded`,
    parameters: { account_id: accountId, session_id: sessionId },
  };
}

/** Resolves the session of one entry and locks it, or `null` when this account has no such entry. */
async function lockEntrySession(
  statements: UserCardsSqlExecutor,
  accountId: string,
  entryId: string,
): Promise<string | null> {
  const request = lockEntrySessionStatement(accountId, entryId);
  const rows = await readRows(
    statements,
    request.statement,
    request.parameters,
    'The pending entry could not be locked.',
  );
  const row = rows[0];
  return row === undefined ? null : textValue(row.session_id);
}

function candidateKey(printingId: string, provider: string, evidence: string): string {
  return `${printingId}\u0000${provider}\u0000${evidence}`;
}

export function createImportReview(
  sql: UserCardsSqlTransactor,
): Pick<ImportStore, 'correctEntry' | 'attachCandidates' | 'discardEntry' | 'discardSession'> {
  return {
    async correctEntry(accountId, correction): Promise<ImportEntryCorrectionOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, correction.entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const update = correctEntryStatement(accountId, correction);
          const rows = await readRows(
            statements,
            update.statement,
            update.parameters,
            'The reviewed entry could not be stored.',
          );
          if (rows[0] === undefined) {
            return { outcome: 'conflict' as const };
          }
          // A review changes the pending state a whole-import discard removes, so it advances the
          // session revision that discard validates.
          const bump = bumpSessionStatement(accountId, located);
          await readRows(
            statements,
            bump.statement,
            bump.parameters,
            'The import session could not be updated.',
          );
          const privateRevision = await advanceRevision(statements, accountId);
          return {
            outcome: 'updated' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, correction.entryId),
          };
        },
        'The reviewed entry could not be committed.',
      );
    },
    async attachCandidates(accountId, attachment): Promise<CandidateAttachmentOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, attachment.entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const current = await readEntry(statements, accountId, attachment.entryId);
          if (current === null) {
            return { outcome: 'missing' as const };
          }
          if (current.state !== 'pending') {
            // A late alternative for an entry that is no longer reviewable changes nothing.
            return {
              outcome: 'recorded' as const,
              privateRevision: await currentRevision(statements, accountId),
              session: await requireSession(statements, accountId, located),
              entry: current,
            };
          }

          const keys = new Set(
            current.candidates.map((candidate) =>
              candidateKey(candidate.printingId, candidate.provider, candidate.evidence),
            ),
          );
          const additions = attachment.candidates.filter(
            (candidate) =>
              !keys.has(candidateKey(candidate.printingId, candidate.provider, candidate.evidence)),
          );
          if (keys.size + additions.length > USERCARDS_LIMITS.maxImportCandidates) {
            throw new UserCardsError(
              'invalid-request',
              `A pending entry keeps at most ${USERCARDS_LIMITS.maxImportCandidates} ` +
                'recognition alternatives.',
            );
          }

          let privateRevision: string;
          if (additions.length === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            const insert = insertCandidateStatement(accountId, attachment.entryId, additions);
            await readRows(
              statements,
              insert.statement,
              insert.parameters,
              'The recognition alternatives could not be stored.',
            );
            // Later alternatives are part of the pending state a whole-import discard removes, so
            // that discard quotes the session revision they published.
            const bump = bumpSessionStatement(accountId, located);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
            privateRevision = await advanceRevision(statements, accountId);
          }
          return {
            outcome: 'recorded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, attachment.entryId),
          };
        },
        'The recognition alternatives could not be committed.',
      );
    },
    async discardEntry(accountId, entryId, expectedRevision): Promise<ImportEntryDiscardOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const located = await lockEntrySession(statements, accountId, entryId);
          if (located === null) {
            return { outcome: 'missing' as const };
          }
          const discard = discardEntryStatement(accountId, entryId, expectedRevision);
          const rows = await readRows(
            statements,
            discard.statement,
            discard.parameters,
            'The pending entry could not be discarded.',
          );
          if (rows[0] === undefined) {
            return { outcome: 'conflict' as const };
          }
          const bump = bumpSessionStatement(accountId, located);
          await readRows(
            statements,
            bump.statement,
            bump.parameters,
            'The import session could not be updated.',
          );
          const privateRevision = await advanceRevision(statements, accountId);
          return {
            outcome: 'discarded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, located),
            entry: await requireEntry(statements, accountId, entryId),
          };
        },
        'The pending entry could not be discarded.',
      );
    },
    async discardSession(
      accountId,
      sessionId,
      expectedRevision,
    ): Promise<ImportSessionDiscardOutcome> {
      return inTransaction(
        sql,
        async (statements) => {
          const lock = lockSessionStatement(accountId, sessionId);
          const locked = await readRows(
            statements,
            lock.statement,
            lock.parameters,
            'The import session could not be locked.',
          );
          const stored = locked[0];
          if (stored === undefined) {
            return { outcome: 'missing' as const };
          }
          if (integerValue(stored.revision) !== expectedRevision) {
            return { outcome: 'conflict' as const };
          }
          const discard = discardPendingEntriesStatement(accountId, sessionId);
          const discarded = await readRows(
            statements,
            discard.statement,
            discard.parameters,
            'The pending entries could not be discarded.',
          );
          let privateRevision: string;
          if (integerValue(discarded[0]?.count) === 0) {
            privateRevision = await currentRevision(statements, accountId);
          } else {
            const bump = bumpSessionStatement(accountId, sessionId);
            await readRows(
              statements,
              bump.statement,
              bump.parameters,
              'The import session could not be updated.',
            );
            privateRevision = await advanceRevision(statements, accountId);
          }
          return {
            outcome: 'discarded' as const,
            privateRevision,
            session: await requireSession(statements, accountId, sessionId),
          };
        },
        'The pending import could not be discarded.',
      );
    },
  };
}
