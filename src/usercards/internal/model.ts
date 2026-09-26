import type { Finish, PrintingId } from '../../catalog/index.js';

/**
 * Physical copies and their attributes (docs/user-cards.md#records-and-associations). A copy has
 * one stable identity and one printing reference; correcting its printing, finish or condition
 * keeps that identity, and an unknown condition stays explicitly unknown until a review supplies
 * one. The component never derives a physical condition from a suggestion.
 */
export type CopyId = string;

export const copyConditions = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export type CopyCondition = (typeof copyConditions)[number];

/**
 * Bounds that keep private reads and changes bounded (docs/user-cards.md#interface). A caller that
 * needs more copies reads further batches; the component never silently truncates a batch.
 */
export const USERCARDS_LIMITS = {
  /** Longest accepted account, copy or printing identifier, counted in JavaScript string units. */
  maxIdentifierLength: 200,
  maxReadReferences: 100,
  maxCreateQuantity: 100,
} as const;

/** Verified account identity Application derives from authentication, never from a caller field. */
export interface TrustedUserContext {
  readonly accountId: string;
}

/** One physical copy: its stable identity, one printing reference and its physical attributes. */
export interface PhysicalCopy {
  readonly copyId: CopyId;
  readonly printingId: PrintingId;
  readonly finish: Finish;
  /** Physical condition code; `null` while the condition is unknown. */
  readonly condition: CopyCondition | null;
  /** Record revision; a correction must quote the revision it started from. */
  readonly revision: number;
}
