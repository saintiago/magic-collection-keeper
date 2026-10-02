/**
 * The migration-loading operations (docs/user-cards.md#interface,
 * docs/migration.md#rehearsal-and-execution-gates). The service verifies the presented plan,
 * recognizes a completed migration from its durable record before the target Catalog is consulted,
 * validates a plan it still has to write against that Catalog, resumes the recorded batches at the
 * first missing one, and reports the recorded outcome of a repeated identical plan. A plan that
 * does not hold, an account that is not empty and a recorded migration that does not match the
 * presented plan are distinct failures; nothing is written before all of them are settled.
 */

import { z } from 'zod';

import type { CatalogResolver } from '../../catalog/index.js';
import { resolveAvailablePrintings, resolveCards } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import {
  migrationArchiveChunks,
  migrationBatches,
  verifyMigrationPlan,
  type MigrationBatch,
  type MigrationPlanAccount,
} from './migration-plan.js';
import type {
  LoadMigrationPlanInput,
  MigrationLoadResult,
  MigrationOperations,
  MigrationReadback,
} from './migration-contract.js';
import { type TrustedUserContext } from './model.js';
import type { MigrationBatchReceipt, MigrationRecord, MigrationStore } from './store.js';

export interface MigrationServiceDependencies {
  /** Private migration storage of the target account. */
  readonly store: MigrationStore;
  /** Catalog contract the plan's printings, cards and finishes must resolve against. */
  readonly catalog: CatalogResolver;
}

const loadRequestSchema = z
  .object({
    plan: z.unknown(),
    sourceDigest: z.string().min(1).max(128),
  })
  .strict();

/** Every recorded batch receipt must name exactly this plan's batch at its index. */
function verifyRecordedBatches(
  batchList: readonly MigrationBatch[],
  receipts: readonly MigrationBatchReceipt[],
): void {
  for (const receipt of receipts) {
    const batch = batchList[receipt.index];
    if (batch === undefined || batch.fingerprint !== receipt.fingerprint) {
      throw new UserCardsError(
        'conflict',
        'The recorded migration batches do not match the prepared plan.',
      );
    }
  }
}

/** A completed migration records every batch of the plan it loaded. */
function requireEveryBatchRecorded(
  batchList: readonly MigrationBatch[],
  receipts: readonly MigrationBatchReceipt[],
): void {
  if (receipts.length !== batchList.length) {
    throw new UserCardsError(
      'unavailable',
      'The migration did not record every batch of the prepared plan.',
    );
  }
}

/** The prepared plan's printings, cards and finishes must still resolve against the target. */
async function validateTargetCatalog(
  catalog: CatalogResolver,
  account: MigrationPlanAccount,
): Promise<void> {
  const printings = new Set<string>();
  for (const copy of account.copies) {
    printings.add(copy.printingId);
  }
  for (const association of account.associations) {
    if (association.targetLevel === 'printing') {
      printings.add(association.targetId);
    }
  }
  for (const entry of account.pending) {
    if (entry.printingId !== null) {
      printings.add(entry.printingId);
    }
    for (const candidate of entry.candidates) {
      printings.add(candidate.printingId);
    }
  }
  const resolved = await resolveAvailablePrintings(catalog, [...printings]);
  for (const printingId of printings) {
    if (!resolved.has(printingId)) {
      throw new UserCardsError(
        'not-found',
        'The migration plan references a printing the target catalog does not publish.',
      );
    }
  }
  for (const copy of account.copies) {
    const printing = resolved.get(copy.printingId);
    if (printing === undefined) {
      throw new UserCardsError(
        'not-found',
        'The migration plan references a printing the target catalog does not publish.',
      );
    }
    if (!printing.physical) {
      throw new UserCardsError(
        'invalid-request',
        'The migration plan carries a copy whose printing is not a physical card.',
      );
    }
    if (!printing.finishes.includes(copy.finish)) {
      throw new UserCardsError(
        'invalid-request',
        'The migration plan carries a copy in a finish its printing does not offer.',
      );
    }
  }
  const cards = account.associations
    .filter((association) => association.targetLevel === 'card')
    .map((association) => association.targetId)
    .concat(account.pending.flatMap((entry) => (entry.cardId === null ? [] : [entry.cardId])));
  if (cards.length > 0) {
    await resolveCards(catalog, cards);
  }
  // A reviewed pending printing must still carry the card the plan reviewed for it; an ordinary
  // review refuses that disagreement too (docs/user-cards.md#interface,
  // docs/migration.md#rehearsal-and-execution-gates).
  for (const entry of account.pending) {
    if (entry.printingId === null) {
      continue;
    }
    const printing = resolved.get(entry.printingId);
    if (printing !== undefined && printing.cardId !== entry.cardId) {
      throw new UserCardsError(
        'invalid-request',
        'The migration plan carries a pending entry whose card and printing do not agree.',
      );
    }
  }
}

export function createMigrationOperations(
  dependencies: MigrationServiceDependencies,
): MigrationOperations {
  const { store, catalog } = dependencies;
  return {
    async loadMigrationPlan(
      context: TrustedUserContext,
      input: LoadMigrationPlanInput,
    ): Promise<MigrationLoadResult> {
      const accountId = accountIdFrom(context);
      const request = loadRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A verified migration plan and its exact source digest are required.',
        );
      }
      const plan = verifyMigrationPlan(request.data.plan, request.data.sourceDigest);
      const account = plan.accounts.find((candidate) => candidate.accountId === accountId);
      if (account === undefined) {
        throw new UserCardsError(
          'invalid-request',
          'The prepared plan does not carry the target account.',
        );
      }
      const batchList = migrationBatches(account);
      const record: MigrationRecord = {
        migrationId: plan.snapshotId,
        planDigest: plan.planDigest,
        sourceDigest: plan.sourceDigest,
        batchCount: batchList.length,
      };
      // A completed migration is recognized from its durable record before the target Catalog is
      // consulted, so its outcome stays recoverable after the Catalog changed or became
      // unavailable; a new load still validates the plan before it writes anything
      // (docs/migration.md#rehearsal-and-execution-gates).
      const recorded = await store.recorded(accountId, record);
      if (recorded?.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The account recorded another plan for this source snapshot.',
        );
      }
      if (recorded !== null && recorded.progress.state === 'completed') {
        verifyRecordedBatches(batchList, recorded.progress.batches);
        requireEveryBatchRecorded(batchList, recorded.progress.batches);
        return {
          snapshotId: plan.snapshotId,
          sourceDigest: plan.sourceDigest,
          planDigest: plan.planDigest,
          totalBatches: batchList.length,
          appliedBatches: 0,

          replayed: true,
        };
      }
      await validateTargetCatalog(catalog, account);
      const started = await store.start(accountId, record, migrationArchiveChunks(plan.archive));
      if (started.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          started.reason === 'nonempty-account'
            ? 'The target account is not empty; a migration loads into an empty account.'
            : 'The account recorded another plan for this source snapshot.',
        );
      }
      let progress = started.progress;
      verifyRecordedBatches(batchList, progress.batches);
      let appliedBatches = 0;
      if (progress.state === 'loading') {
        for (const batch of batchList) {
          if (progress.batches.some((receipt) => receipt.index === batch.index)) {
            continue;
          }
          const outcome = await store.applyBatch(accountId, record.migrationId, batch);
          if (outcome.outcome === 'conflict') {
            throw new UserCardsError(
              'conflict',
              'The recorded migration batches do not match the prepared plan.',
            );
          }
          if (outcome.outcome === 'applied') {
            appliedBatches += 1;
          }
        }
        progress = await store.complete(accountId, record.migrationId);
      }
      requireEveryBatchRecorded(batchList, progress.batches);
      return {
        snapshotId: plan.snapshotId,
        sourceDigest: plan.sourceDigest,
        planDigest: plan.planDigest,
        totalBatches: batchList.length,
        appliedBatches,

        replayed: appliedBatches === 0 && started.outcome === 'recorded',
      };
    },

    async readMigrationReadback(context: TrustedUserContext): Promise<MigrationReadback> {
      const accountId = accountIdFrom(context);
      const outcome = await store.readReadback(accountId);
      switch (outcome.outcome) {
        case 'read':
          return outcome.readback;
        case 'absent':
          throw new UserCardsError('not-found', 'The account records no migration.');
        case 'incomplete':
          throw new UserCardsError('conflict', 'The recorded migration has not completed.');
      }
    },
  };
}
