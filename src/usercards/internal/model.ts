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

export type ImportSessionId = string;
export type ImportEntryId = string;
export type ImportOperationId = string;

/**
 * Explicit destination one confirmation applies to its reviewed entries
 * (docs/user-cards.md#import-and-capture-state). A tag destination creates or updates the reviewed
 * card/printing associations with their intended quantities; only the explicit ownership
 * destination creates individual physical copies, acquisition provenance and owned memberships.
 */
export type ImportDestination =
  { readonly kind: 'tag'; readonly tagId: TagId } | { readonly kind: 'ownership' };

export const importEntryStates = ['pending', 'confirmed', 'discarded'] as const;
export type ImportEntryState = (typeof importEntryStates)[number];

export const importSessionStates = ['pending', 'confirmed', 'discarded'] as const;
export type ImportSessionState = (typeof importSessionStates)[number];

/**
 * One recognition alternative stored with a pending entry: a resolved printing reference and the
 * bounded provider and evidence labels that produced it. Recognition owns the provider and
 * evidence vocabulary; UserCards stores the labels and never reinterprets them
 * (docs/user-cards.md#import-and-capture-state).
 */
export interface ImportCandidate {
  readonly printingId: PrintingId;
  readonly provider: string;
  readonly evidence: string;
}

/**
 * One parsed source line (docs/user-cards.md#source-imports): what a pasted card list, a Moxfield
 * deck or a reviewed Wizards preconstructed list published for one pending entry, kept
 * independently of the reviewed values and of the physical copies the line eventually produces. An
 * unresolved name or printing stays reviewable because the entry keeps what its source said, and a
 * replay of the same import can recognize the line from this identity.
 */
export interface ImportSourceLine {
  /** Card name the source published; null when it named none. */
  readonly name: string | null;
  /** Deck section the line belongs to, for example `mainboard`; null for a flat list. */
  readonly section: string | null;
  /** Edition code the source published; null when it published none. */
  readonly set: string | null;
  /** Collector number the source published; null when it published none. */
  readonly collectorNumber: string | null;
  /** Printing language the source published; null when it published none. */
  readonly language: string | null;
  /** Finish the source declared; null when it declared none and the review must choose one. */
  readonly finish: Finish | null;
  /** Quantity the source declared for this line when it was parsed. */
  readonly declaredQuantity: number;
  /** Why the line needs the owner's review, or null when it resolved without one. */
  readonly problem: string | null;
}

/**
 * One persisted pending entry (docs/user-cards.md#import-and-capture-state): its stable capture or
 * source-line identity, the identity of the import session it belongs to, its position in that
 * session's capture order, the reviewed values and the recognition alternatives stored for it.
 * Pending entries are never owned copies; confirmation creates individual copies separately and
 * leaves the entry's provenance behind.
 */
export interface ImportEntry {
  readonly entryId: ImportEntryId;
  readonly sessionId: ImportSessionId;
  /** Position in the session's capture order, oldest first; edits never reorder it. */
  readonly position: number;
  readonly state: ImportEntryState;
  /**
   * Reviewed playable card identity; `null` while the entry is unresolved. A card-level review is
   * sufficient for an association destination, so an entry can name a card without a printing.
   */
  readonly cardId: string | null;
  /** Reviewed printing reference; `null` for a card-level review or an unresolved entry. */
  readonly printingId: PrintingId | null;
  /** Optional reviewed finish; physical eligibility is required only for ownership confirmation. */
  readonly finish: Finish | null;
  /** Reviewed physical condition; `null` while the condition is unknown. */
  readonly condition: CopyCondition | null;
  /**
   * Explicit pending quantity; its meaning follows the destination the confirmation applies: an
   * intended quantity for a tag destination, or the number of individual copies an explicit
   * ownership action creates (docs/user-cards.md#import-and-capture-state).
   */
  readonly quantity: number;
  readonly candidates: readonly ImportCandidate[];
  /**
   * Parsed source line this entry came from; null for a capture observation or a directly staged
   * entry. It keeps the source's own description beside the reviewed values.
   */
  readonly sourceLine: ImportSourceLine | null;
  /** Reviewed revision; a review, discard or confirmation quotes the revision it started from. */
  readonly revision: number;
}

/**
 * One import session: the persisted part of a browser-resident capture session or of a parsed
 * source import (docs/user-cards.md#import-and-capture-state). Each new import has its own stable
 * identity, even when another import carries identical cards or the same source reference; the
 * session keeps the import identity that replay protection is based on, the provenance its source
 * published, the last accepted capture identity, and its own change revision. Its lifecycle state
 * follows the entries it still holds, so a session is pending while entries are reviewable and
 * confirmed or discarded once they are not.
 */
export interface ImportSession {
  readonly sessionId: ImportSessionId;
  /** Source family of the acquisition, for example a capture session or a pasted list. */
  readonly sourceKind: string;
  /**
   * Published identity of the import's source, preserved independently of the copies it produced;
   * a source that publishes none, like a pasted list, carries the import's own identity.
   */
  readonly sourceId: string;
  /**
   * Official reference of the acquisition source, for example the Wizards decklist the owner
   * reviewed or the canonical Moxfield deck link; null when the source published none.
   */
  readonly sourceReference: string | null;
  /** Derived lifecycle state: pending while the session has pending entries or none yet. */
  readonly state: ImportSessionState;
  readonly pendingEntries: number;
  readonly confirmedEntries: number;
  readonly discardedEntries: number;
  /** Revision of the session's pending set; a discard quotes the revision it started from. */
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
  /**
   * Most records one private write statement carries; a larger change writes further bounded
   * batches inside the same transaction, because the deployed write transport rejects oversized
   * statements.
   */
  maxRecordsPerStatement: 100,
  /**
   * Most recorded copies one private statement returns. A recorded outcome larger than the
   * deployed transport's response bound is read as further bounded pages instead of one oversized
   * result.
   */
  maxReceiptCopiesPerRead: 100,
  /**
   * Largest intended quantity a card- or printing-level association may carry, and the largest
   * reviewed quantity one pending entry may carry: the meaning of a pending quantity follows the
   * destination its confirmation applies. It is a product bound independent of the request batch
   * size, so a deck requirement is never capped by an incidental storage or transport batch and
   * accumulates across confirmations up to this bound
   * (docs/user-cards.md#records-and-associations, docs/testing.md#usercards).
   */
  maxAssociationQuantity: 1_000_000,
  defaultTagPageSize: 50,
  minTagPageSize: 1,
  maxTagPageSize: 100,
  /**
   * Page bounds of one tag's associations. A tag with more associations than one page is read
   * through its bounded continuation, like the tags themselves.
   */
  defaultAssociationPageSize: 50,
  minAssociationPageSize: 1,
  maxAssociationPageSize: 100,
  /** Largest number of pending entries one staging call stages. */
  maxStageEntries: 50,
  /** Largest number of reviewed entries one confirmation covers. */
  maxConfirmEntries: 50,
  /** Most recognition alternatives stored with one pending entry. */
  maxImportCandidates: 8,
  /** Largest number of lines one source import parses into pending entries. */
  maxSourceLines: 500,
  /** Longest pasted source text accepted, counted in JavaScript string units. */
  maxSourceTextLength: 128 * 1024,
  /** Longest official source reference kept with an import session. */
  maxSourceReferenceLength: 500,
  /** Longest reason a parsed source line carries for the owner's review. */
  maxSourceProblemLength: 300,
  defaultImportPageSize: 50,
  minImportPageSize: 1,
  maxImportPageSize: 100,
  /**
   * Most records one migration batch carries. A batch commits its records, its replay receipt and
   * any query-visible publication together, so this bounds a migration's commit while a larger
   * plan loads as further batches (docs/migration.md#rehearsal-and-execution-gates).
   */
  maxMigrationBatchRecords: 100,
  /**
   * Longest archive chunk one durable migration evidence row carries. 12288 code units encode to
   * at most 48 KiB, so one evidence row stays below the deployed read transport's per-row bound.
   */
  maxMigrationArchiveChunkLength: 12_288,
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
