/**
 * The migration-loading contract of UserCards (docs/user-cards.md#interface,
 * docs/migration.md#ownership-and-interfaces). The provider owns the loader, the durable source
 * evidence and the private readback the reconciliation compares; the offline utility owns
 * conversion and reconciliation. The loader consumes only a verified prepared plan
 * (docs/migration.md#rehearsal-and-execution-gates).
 */

import type {
  Association,
  ImportEntry,
  ImportSession,
  PhysicalCopy,
  Tag,
  TrustedUserContext,
} from './model.js';
import type { MigrationPlan } from './migration-plan.js';

export interface LoadMigrationPlanInput {
  /** Verified prepared plan of one source snapshot, as the offline utility produced it. */
  readonly plan: MigrationPlan;
  /** Exact digest the operator recorded for the plan's source archive. */
  readonly sourceDigest: string;
}

/**
 * What a completed load recorded. A load returns only once its migration is complete, so the
 * recorded progress always covers every batch; a repeated identical plan reports the recorded
 * outcome instead of writing again.
 */
export interface MigrationLoadResult {
  /** Verified source snapshot identity this migration is recorded under. */
  readonly snapshotId: string;
  readonly sourceDigest: string;
  readonly planDigest: string;
  /** Batches the plan is loaded in. */
  readonly totalBatches: number;
  /** Batches this call applied; the remainder were already recorded identically. */
  readonly appliedBatches: number;
  /** Whether the call returned the completed outcome recorded before it. */
  readonly replayed: boolean;
}

/**
 * The private readback reconciliation compares (docs/migration.md#rehearsal-and-execution-gates).
 * It reads the target's authoritative private records, not a Search projection, and reports the
 * durable archive by digest. The provider's system tag and its ownership memberships stay out of
 * the user tag and association arrays: the copies carrying that membership are reported separately
 * and excluded from the user-defined arrays' meaning.
 */
export interface MigrationReadback {
  readonly accountId: string;
  readonly copies: readonly PhysicalCopy[];
  /** Identities carrying the provider's system ownership membership. */
  readonly ownedCopyIds: readonly string[];
  /** User-defined tags, excluding the provider-managed system tag. */
  readonly tags: readonly Tag[];
  /** User-defined associations, excluding the system ownership memberships. */
  readonly associations: readonly Association[];
  readonly sessions: readonly ImportSession[];
  readonly pending: readonly ImportEntry[];
  /** Digest of the durable private legacy archive, equal to the plan's source digest. */
  readonly archiveDigest: string;
}

/** The migration-loading operations of the UserCards contract. */
export interface MigrationOperations {
  /**
   * Loads one verified prepared plan into the trusted context's account, which must be empty, and
   * records durable batch progress, the durable source archive and a repeat-safe outcome.
   */
  loadMigrationPlan(
    context: TrustedUserContext,
    input: LoadMigrationPlanInput,
  ): Promise<MigrationLoadResult>;
  /** Reads the completed migration's private records and archive digest for reconciliation. */
  readMigrationReadback(context: TrustedUserContext): Promise<MigrationReadback>;
}
