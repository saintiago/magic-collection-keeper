import { canonical } from './legacy.js';
import { verifyPlan, type MigrationPlan } from './prepare.js';
import type { ImportEntry, MigrationReadback } from '../../src/usercards/index.js';

/**
 * Readback from the isolated target: the provider-owned private readback contract UserCards
 * supplies for reconciliation (`readMigrationReadback`), never a writer or a Search result.
 */
export type { MigrationReadback };

/**
 * The reviewed pending state reconciliation compares: the entry's identity, reviewed values and
 * retained source line, without the plan's conversion references. Both sides are projected, so the
 * plan's extra evidence and the readback's own record shape cannot decide the comparison.
 */
function pendingCheck(entry: ImportEntry) {
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
      pending: expected.pending.map(pendingCheck),
    };
    const recorded = {
      copies: found.copies,
      tags: found.tags,
      associations: found.associations,
      sessions: found.sessions,
      pending: found.pending.map(pendingCheck),
    };
    for (const key of ['copies', 'tags', 'associations', 'sessions', 'pending'] as const) {
      const sorted = (rows: readonly unknown[]) => rows.map(canonical).sort();
      if (canonical(sorted(checks[key])) !== canonical(sorted(recorded[key])))
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
