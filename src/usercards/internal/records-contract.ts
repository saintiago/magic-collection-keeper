import { type CatalogResolver, type Finish } from '../../catalog/index.js';
import type { UserCardsSqlTransactor } from './executor.js';
import { type ImportOperations } from './import-contract.js';
import {
  type Association,
  type AssociationId,
  type AssociationTargetLevel,
  type CopyCondition,
  type CopyId,
  type PhysicalCopy,
  type Tag,
  type TagId,
  type TrustedUserContext,
  type UserTagKind,
} from './model.js';

/** One copy request: one printing, its finish and condition, repeated `quantity` times. */
export interface CreateCopiesInput {
  readonly printingId: string;
  readonly finish: Finish;
  /** Physical condition; `null` stores the copy with an explicitly unknown condition. */
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

/**
 * The corrected state of one copy, guarded by the revision the caller read. The copy keeps its
 * identity, while printing, finish and condition are replaced as one explicit change.
 */
export interface CorrectCopyInput {
  readonly copyId: CopyId;
  readonly expectedRevision: number;
  readonly printingId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

export interface CopyReadResult {
  /** Private-data revision the read observed; a continuation binds to this value. */
  readonly privateRevision: string;
  /** Authorized copies keyed by copy identity. */
  readonly copies: ReadonlyMap<CopyId, PhysicalCopy>;
  /** Requested references this account has no copy for, in request order. */
  readonly missing: readonly CopyId[];
}

export interface CopyChangeResult {
  /** Private-data revision the change published. */
  readonly privateRevision: string;
  /** Committed affected copies, ordered by copy identity. */
  readonly copies: readonly PhysicalCopy[];
}

/** One new tag: its kind and editable label (docs/user-cards.md#records-and-associations). */
export interface CreateTagInput {
  readonly kind: UserTagKind;
  readonly label: string;
}

/** The renamed state of one tag, guarded by the revision the caller read. */
export interface RenameTagInput {
  readonly tagId: TagId;
  readonly expectedRevision: number;
  readonly label: string;
}

export interface TagReadResult {
  readonly privateRevision: string;
  /** Authorized tags keyed by tag identity. */
  readonly tags: ReadonlyMap<TagId, Tag>;
  /** Requested references this account has no tag for, in request order. */
  readonly missing: readonly TagId[];
}

export interface TagListOptions {
  readonly pageSize?: number;
  /** Continuation from the previous page of the same account's tags. */
  readonly continuation?: string;
}

export interface TagListResult {
  readonly privateRevision: string;
  /** Page of tags ordered by stable tag identity. */
  readonly tags: readonly Tag[];
  /** Continuation for the next page, or null when this page ends the list. */
  readonly continuation: string | null;
}

export interface TagChangeResult {
  readonly privateRevision: string;
  readonly tag: Tag;
}

/**
 * One new association. A card or printing target carries its intended quantity; a copy target is
 * physical membership and carries none.
 */
export interface CreateAssociationInput {
  readonly tagId: TagId;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity?: number | null;
}

/**
 * The changed state of one association, guarded by the revision the caller read. Refining or
 * broadening between card and printing levels keeps the association identity.
 */
export interface ChangeAssociationInput {
  readonly associationId: AssociationId;
  readonly expectedRevision: number;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity?: number | null;
}

export interface RemoveAssociationInput {
  readonly associationId: AssociationId;
  readonly expectedRevision: number;
}

export interface AssociationReadResult {
  readonly privateRevision: string;
  /** Authorized associations keyed by association identity. */
  readonly associations: ReadonlyMap<AssociationId, Association>;
  /** Requested references this account has no association for, in request order. */
  readonly missing: readonly AssociationId[];
}

export interface AssociationChangeResult {
  readonly privateRevision: string;
  readonly association: Association;
}

export interface AssociationRemovalResult {
  readonly privateRevision: string;
  readonly associationId: AssociationId;
}

/**
 * A change of one copy's single physical location. The move quotes the copy revision it started
 * from, replaces any previous location membership and never changes ownership.
 */
export interface SetCopyLocationInput {
  readonly copyId: CopyId;
  /** Location tag to move the copy into, or `null` to remove its location. */
  readonly locationTagId: TagId | null;
  readonly expectedRevision: number;
}

export interface CopyLocationResult {
  readonly privateRevision: string;
  /** Committed copy with its published revision. */
  readonly copy: PhysicalCopy;
  /** Committed location membership, or null when the copy has no location. */
  readonly location: Association | null;
}

/**
 * The UserCards contract for private records. Every operation takes Application's trusted user
 * context and scopes the referenced records and changes to that account; a read never returns or
 * reveals another account's record, and a change either commits completely or reports a distinct
 * failure (docs/user-cards.md#interface).
 */
export interface UserCards extends ImportOperations {
  readCopies(context: TrustedUserContext, copyIds: readonly CopyId[]): Promise<CopyReadResult>;
  createCopies(context: TrustedUserContext, input: CreateCopiesInput): Promise<CopyChangeResult>;
  correctCopy(context: TrustedUserContext, input: CorrectCopyInput): Promise<CopyChangeResult>;
  readTags(context: TrustedUserContext, tagIds: readonly TagId[]): Promise<TagReadResult>;
  listTags(context: TrustedUserContext, options?: TagListOptions): Promise<TagListResult>;
  createTag(context: TrustedUserContext, input: CreateTagInput): Promise<TagChangeResult>;
  renameTag(context: TrustedUserContext, input: RenameTagInput): Promise<TagChangeResult>;
  readAssociations(
    context: TrustedUserContext,
    associationIds: readonly AssociationId[],
  ): Promise<AssociationReadResult>;
  createAssociation(
    context: TrustedUserContext,
    input: CreateAssociationInput,
  ): Promise<AssociationChangeResult>;
  changeAssociation(
    context: TrustedUserContext,
    input: ChangeAssociationInput,
  ): Promise<AssociationChangeResult>;
  removeAssociation(
    context: TrustedUserContext,
    input: RemoveAssociationInput,
  ): Promise<AssociationRemovalResult>;
  setCopyLocation(
    context: TrustedUserContext,
    input: SetCopyLocationInput,
  ): Promise<CopyLocationResult>;
}

export interface UserCardsDependencies {
  /**
   * Transaction-capable SQL executor supplied by Application. Statements use `:name` placeholders
   * and read or write the component's own storage; consumers read the published views instead.
   */
  readonly sql: UserCardsSqlTransactor;
  /**
   * CatalogResolver contract used to resolve card and printing references and validate physical-printing
   * attributes. A copy or association never stores a reference the catalog cannot resolve.
   */
  readonly catalog: CatalogResolver;
}
