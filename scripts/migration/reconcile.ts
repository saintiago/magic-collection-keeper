import { canonical } from './legacy.js';
import { verifyPlan, type MigrationPlan } from './prepare.js';
import type {
  Association,
  ImportEntry,
  ImportSession,
  PhysicalCopy,
  Tag,
} from '../../src/usercards/index.js';

/** Readback from the isolated target, using provider contracts; not a writer or a Search result. */
export interface MigrationReadback {
  accountId: string;
  copies: readonly PhysicalCopy[];
  /** IDs carrying the provider's system ownership membership. */
  ownedCopyIds: readonly string[];
  /** User-defined tags and memberships, excluding provider-managed system records. */
  tags: readonly Tag[];
  associations: readonly Association[];
  sessions: readonly ImportSession[];
  pending: readonly ImportEntry[];
  /** Digest of the durable private legacy archive and its replay evidence. */
  archiveDigest: string;
}

/** Exact per-identity reconciliation catches offsetting losses that aggregate totals conceal. */
export function reconcileMigration(
  plan: MigrationPlan,
  actual: readonly MigrationReadback[],
): string[] {
  verifyPlan(plan);
  const failures: string[] = [];
  const expectedAccounts = new Set(plan.accounts.map((a) => a.accountId));
  if (new Set(actual.map((a) => a.accountId)).size !== actual.length)
    failures.push('duplicate account readback');
  for (const a of actual)
    if (!expectedAccounts.has(a.accountId)) failures.push(`${a.accountId}: unexpected account`);
  for (const expected of plan.accounts) {
    const found = actual.find((a) => a.accountId === expected.accountId);
    if (!found) {
      failures.push(`${expected.accountId}: missing account`);
      continue;
    }
    if (found.archiveDigest !== plan.sourceDigest)
      failures.push(`${expected.accountId}: archive mismatch`);
    const checks = {
      copies: expected.copies.map(({ copyId, printingId, finish, condition, revision }) => ({
        copyId,
        printingId,
        finish,
        condition,
        revision,
      })),
      tags: expected.tags.map(({ tagId, kind, label, system, revision }) => ({
        tagId,
        kind,
        label,
        system,
        revision,
      })),
      associations: expected.associations,
      sessions: expected.sessions,
      pending: expected.pending.map((entry) => {
        const {
          entryId,
          sessionId,
          position,
          state,
          printingId,
          finish,
          condition,
          quantity,
          revision,
          candidates,
          sourceLine,
        } = entry;
        return {
          entryId,
          sessionId,
          position,
          state,
          printingId,
          finish,
          condition,
          quantity,
          revision,
          candidates,
          sourceLine,
        };
      }),
    };
    for (const key of ['copies', 'tags', 'associations', 'sessions', 'pending'] as const) {
      const sorted = (rows: readonly unknown[]) => rows.map(canonical).sort();
      if (canonical(sorted(checks[key])) !== canonical(sorted(found[key])))
        failures.push(`${expected.accountId}: ${key} mismatch`);
    }
    if (
      canonical([...found.ownedCopyIds].sort()) !==
      canonical(expected.copies.map((c) => c.copyId).sort())
    ) {
      failures.push(`${expected.accountId}: ownership mismatch`);
    }
  }
  return failures;
}
