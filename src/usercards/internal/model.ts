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

export type TagId = string;
export type AssociationId = string;

/**
 * Tag kinds (docs/architecture.md#tags-and-associations). `deck`, `wishlist`, `location` and
 * `other` are the account's own tags; `owned` is the account's system-defined ownership tag, which
 * the component creates and associates with stored copies instead of exposing it to tag editing.
 */
export const tagKinds = ['deck', 'wishlist', 'location', 'other', 'owned'] as const;
export type TagKind = (typeof tagKinds)[number];

/** Tag kinds a caller creates and edits through the tag operations. */
export const userTagKinds = ['deck', 'wishlist', 'location', 'other'] as const;
export type UserTagKind = (typeof userTagKinds)[number];

/** One tag: a stable identity, its kind and an editable label (docs/user-cards.md#records-and-associations). */
export interface Tag {
  readonly tagId: TagId;
  readonly kind: TagKind;
  readonly label: string;
  /** True for the account's system-managed tag, whose lifecycle the tag operations do not drive. */
  readonly system: boolean;
  /** Record revision; a rename must quote the revision it started from. */
  readonly revision: number;
}

export const associationTargetLevels = ['card', 'printing', 'copy'] as const;
export type AssociationTargetLevel = (typeof associationTargetLevels)[number];

/**
 * Target levels each tag kind may associate. Card and printing membership carry the intended or
 * required quantity; copy membership is a physical count and carries none. Location membership and
 * ownership are written by the copy location operation and by copy storage respectively, not by the
 * generic association operations (docs/architecture.md#tags-and-associations).
 */
export const associationLevelsByTagKind: Readonly<
  Record<TagKind, readonly AssociationTargetLevel[]>
> = {
  deck: ['card', 'printing', 'copy'],
  wishlist: ['card', 'printing'],
  location: ['copy'],
  other: ['card', 'printing', 'copy'],
  owned: ['copy'],
};

/**
 * Membership of a card, printing or individual copy in a tag. Card and printing associations carry
 * the intended quantity; copy-targeted associations are physical membership and carry none. A
 * refinement between card and printing levels keeps the association identity.
 */
export interface Association {
  readonly associationId: AssociationId;
  readonly tagId: TagId;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  /** Intended quantity for a card or printing target; `null` for a copy target. */
  readonly quantity: number | null;
  /** Record revision; a change must quote the revision it started from. */
  readonly revision: number;
}

/**
 * Bounds that keep private reads and changes bounded (docs/user-cards.md#interface). A caller that
 * needs more records reads further batches; the component never silently truncates a batch.
 */
export const USERCARDS_LIMITS = {
  /**
   * Longest accepted account, copy, tag or association reference or label, counted in JavaScript
   * string units.
   */
  maxIdentifierLength: 200,
  maxReadReferences: 100,
  maxCreateQuantity: 100,
  /** Largest intended quantity a card- or printing-level association may carry. */
  maxAssociationQuantity: 1000,
  defaultTagPageSize: 50,
  minTagPageSize: 1,
  maxTagPageSize: 100,
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
