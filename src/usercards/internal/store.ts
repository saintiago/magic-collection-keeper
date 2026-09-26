import type { Finish, PrintingId } from '../../catalog/index.js';
import type {
  Association,
  AssociationTargetLevel,
  CopyCondition,
  PhysicalCopy,
  Tag,
  TagKind,
  UserTagKind,
} from './model.js';

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
  /**
   * Stores `copies` for `accountId`, associates each stored copy with the account's owned tag and
   * advances that account's private revision, all in one transaction.
   */
  insertCopies(accountId: string, copies: readonly NewCopy[]): Promise<CopiesData>;
  /** Applies `correction` when the stored copy still carries `expectedRevision`. */
  correctCopy(accountId: string, correction: CopyCorrection): Promise<CopyCorrectionOutcome>;
}

/** One tag about to be stored; its stable identity is already assigned. */
export interface NewTag {
  readonly tagId: string;
  readonly kind: UserTagKind;
  readonly label: string;
}

/** The renamed state of one existing tag, guarded by the revision it was read at. */
export interface TagCorrection {
  readonly tagId: string;
  readonly expectedRevision: number;
  readonly label: string;
}

/** Tags of one account together with the private-data revision that was observed with them. */
export interface TagsData {
  readonly privateRevision: string;
  readonly tags: readonly Tag[];
}

/** One committed tag together with the private-data revision the change published. */
export interface TagChangeData {
  readonly privateRevision: string;
  readonly tag: Tag;
}

export type TagCorrectionOutcome =
  | { readonly outcome: 'updated'; readonly privateRevision: string; readonly tag: Tag }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' }
  /** The tag is system-managed; its lifecycle is not driven by the tag operations. */
  | { readonly outcome: 'system' };

/** One association about to be stored; its stable identity is already assigned. */
export interface NewAssociation {
  readonly associationId: string;
  readonly tagId: string;
  readonly tagKind: TagKind;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity: number | null;
}

/** The changed state of one association, guarded by the revision it was read at. */
export interface AssociationCorrection {
  readonly associationId: string;
  readonly expectedRevision: number;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity: number | null;
}

/** Associations of one account together with the private-data revision that was observed with them. */
export interface AssociationsData {
  readonly privateRevision: string;
  readonly associations: readonly Association[];
}

export type AssociationInsertOutcome =
  | {
      readonly outcome: 'inserted';
      readonly privateRevision: string;
      readonly association: Association;
    }
  /** The tag already associates this exact target; the existing association must be changed. */
  | { readonly outcome: 'conflict' };

export type AssociationCorrectionOutcome =
  | {
      readonly outcome: 'updated';
      readonly privateRevision: string;
      readonly association: Association;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' }
  /** Another association of the same tag already covers the requested target. */
  | { readonly outcome: 'duplicate' };

export type AssociationRemovalOutcome =
  | {
      readonly outcome: 'removed';
      readonly privateRevision: string;
      readonly associationId: string;
    }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'conflict' };

export interface CopyLocationChange {
  readonly copyId: string;
  /** Revision of the copy whose location changes; a move quotes the revision it started from. */
  readonly expectedRevision: number;
  /**
   * Location tag to move the copy into, or `null` to remove its location. The service validates
   * that the tag belongs to the account and is a location tag before the move is applied.
   */
  readonly locationTagId: string | null;
}

export type CopyLocationOutcome =
  | {
      readonly outcome: 'moved';
      readonly privateRevision: string;
      readonly copy: PhysicalCopy;
      /** The copy's location membership after the move, or `null` when it has none. */
      readonly location: Association | null;
    }
  | { readonly outcome: 'missing-copy' }
  | { readonly outcome: 'conflict' };

/**
 * Private tag and association storage of one account. Every operation is scoped by the account the
 * caller passes and never returns another account's record; a replacement implementation keeps the
 * same promises, including one physical location per copy (docs/user-cards.md#records-and-associations).
 */
export interface OrganizationStore {
  /** Reads the tags among `tagIds` that belong to `accountId`, with the observed revision. */
  readTags(accountId: string, tagIds: readonly string[]): Promise<TagsData>;
  /** Reads up to `limit` tags of `accountId` ordered by tag identity, starting at `offset`. */
  listTags(accountId: string, offset: number, limit: number): Promise<TagsData>;
  /** Stores `tag` for `accountId` and advances that account's private revision atomically. */
  createTag(accountId: string, tag: NewTag): Promise<TagChangeData>;
  /** Applies `correction` when the stored tag still carries `expectedRevision` and is not system-managed. */
  correctTag(accountId: string, correction: TagCorrection): Promise<TagCorrectionOutcome>;
  /** Reads the associations among `associationIds` that belong to `accountId`. */
  readAssociations(accountId: string, associationIds: readonly string[]): Promise<AssociationsData>;
  /** Stores `association` for `accountId` unless the tag already associates that target. */
  insertAssociation(
    accountId: string,
    association: NewAssociation,
  ): Promise<AssociationInsertOutcome>;
  /** Applies `correction` when the stored association still carries `expectedRevision`. */
  correctAssociation(
    accountId: string,
    correction: AssociationCorrection,
  ): Promise<AssociationCorrectionOutcome>;
  /** Removes the association when it still carries `expectedRevision`. */
  removeAssociation(
    accountId: string,
    associationId: string,
    expectedRevision: number,
  ): Promise<AssociationRemovalOutcome>;
  /** Moves or clears the single location membership of one copy. */
  moveCopyLocation(accountId: string, change: CopyLocationChange): Promise<CopyLocationOutcome>;
}
