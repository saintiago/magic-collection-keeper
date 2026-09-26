import type { Finish, PrintingId } from '../../catalog/index.js';
import type { CopyCondition, PhysicalCopy } from './model.js';

/** One physical copy about to be stored; its stable identity is already assigned. */
export interface NewCopy {
  readonly copyId: string;
  readonly printingId: PrintingId;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

/** The corrected state of one existing copy, guarded by the revision it was read at. */
export interface CopyCorrection {
  readonly copyId: string;
  readonly expectedRevision: number;
  readonly printingId: PrintingId;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

/** Copies of one account together with the private-data revision that was observed with them. */
export interface CopiesData {
  readonly privateRevision: string;
  readonly copies: readonly PhysicalCopy[];
}

export type CopyCorrectionOutcome =
  | { readonly outcome: 'updated'; readonly privateRevision: string; readonly copy: PhysicalCopy }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

/**
 * Private copy storage of one account. Every operation is scoped by the account the caller passes,
 * and the storage never returns another account's record; a replacement implementation keeps the
 * same promises (docs/user-cards.md#interface).
 */
export interface CopyStore {
  /** Reads the copies among `copyIds` that belong to `accountId`, with the observed revision. */
  readCopies(accountId: string, copyIds: readonly string[]): Promise<CopiesData>;
  /** Stores `copies` for `accountId` and advances that account's private revision atomically. */
  insertCopies(accountId: string, copies: readonly NewCopy[]): Promise<CopiesData>;
  /** Applies `correction` when the stored copy still carries `expectedRevision`. */
  correctCopy(accountId: string, correction: CopyCorrection): Promise<CopyCorrectionOutcome>;
}
