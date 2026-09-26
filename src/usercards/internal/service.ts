import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  CatalogError,
  finishes,
  type Catalog,
  type CatalogReference,
  type CatalogResolution,
  type Finish,
} from '../../catalog/index.js';
import { UserCardsError } from './errors.js';
import type { UserCardsSqlTransactor } from './executor.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  associationTargetLevels,
  copyConditions,
  userTagKinds,
  type Association,
  type AssociationId,
  type AssociationTargetLevel,
  type CopyCondition,
  type CopyId,
  type PhysicalCopy,
  type Tag,
  type TagId,
  type TagKind,
  type TrustedUserContext,
  type UserTagKind,
} from './model.js';
import { createPostgresOrganizationStore } from './organization.js';
import { createPostgresCopyStore } from './postgres.js';
import type { CopyStore, OrganizationStore } from './store.js';

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
export interface UserCards {
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
   * Catalog contract used to resolve card and printing references and validate physical-printing
   * attributes. A copy or association never stores a reference the catalog cannot resolve.
   */
  readonly catalog: Catalog;
}

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

const userContextSchema = z.object({
  accountId: z.string().min(1).max(identifierLength),
});

const referenceSchema = z.string().min(1).max(identifierLength);
const referencesSchema = z.array(referenceSchema).max(USERCARDS_LIMITS.maxReadReferences);
const revisionSchema = z.number().int().min(1);
const conditionSchema = z.enum(copyConditions).nullable();
const labelSchema = z.string().min(1).max(identifierLength);
const quantitySchema = z
  .number()
  .int()
  .min(1)
  .max(USERCARDS_LIMITS.maxAssociationQuantity)
  .nullable()
  .optional();

const createCopiesRequestSchema = z.object({
  printingId: referenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
  quantity: z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity),
});

const correctCopyRequestSchema = z.object({
  copyId: referenceSchema,
  expectedRevision: revisionSchema,
  printingId: referenceSchema,
  finish: z.enum(finishes),
  condition: conditionSchema,
});

const createTagRequestSchema = z.object({
  kind: z.enum(userTagKinds),
  label: labelSchema,
});

const renameTagRequestSchema = z.object({
  tagId: referenceSchema,
  expectedRevision: revisionSchema,
  label: labelSchema,
});

const tagPageSizeSchema = z
  .number()
  .int()
  .min(USERCARDS_LIMITS.minTagPageSize)
  .max(USERCARDS_LIMITS.maxTagPageSize);

const tagContinuationPayloadSchema = z.object({
  version: z.literal(1),
  offset: z.number().int().min(0),
  revision: referenceSchema,
});

type TagContinuationPayload = z.infer<typeof tagContinuationPayloadSchema>;

/**
 * Longest token `encodeTagContinuation` can emit: the revision is bounded by the identifier bound,
 * JSON escaping can spend six bytes on one string unit (`"\uXXXX"`), base64url expands by 4/3 and
 * the payload keys and an integer offset fit the remaining margin. The decoder accepts every token
 * its encoder can produce.
 */
const maxTagContinuationLength = 4 * Math.ceil((6 * identifierLength + 64) / 3);

const associationTargetSchema = z.object({
  targetLevel: z.enum(associationTargetLevels),
  targetId: referenceSchema,
  quantity: quantitySchema,
});

const createAssociationRequestSchema = associationTargetSchema.extend({
  tagId: referenceSchema,
});

const changeAssociationRequestSchema = associationTargetSchema.extend({
  associationId: referenceSchema,
  expectedRevision: revisionSchema,
});

const removeAssociationRequestSchema = z.object({
  associationId: referenceSchema,
  expectedRevision: revisionSchema,
});

const setCopyLocationRequestSchema = z.object({
  copyId: referenceSchema,
  locationTagId: referenceSchema.nullable(),
  expectedRevision: revisionSchema,
});

/**
 * The UserCards contract for private records. Copies, tags and associations are validated against
 * the published catalog and the component's own rules before they are stored, so an unavailable
 * reference is an explicit failure rather than a stored record that nothing can resolve.
 */
export function createUserCards(dependencies: UserCardsDependencies): UserCards {
  const sql: UserCardsSqlTransactor | undefined = dependencies?.sql;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') {
    throw new TypeError('createUserCards requires a transaction-capable SQL executor.');
  }
  const catalog: Catalog | undefined = dependencies?.catalog;
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError('createUserCards requires the Catalog contract to resolve printings.');
  }
  const store: CopyStore = createPostgresCopyStore(sql);
  const organization: OrganizationStore = createPostgresOrganizationStore(sql);

  return {
    async readCopies(
      context: TrustedUserContext,
      copyIds: readonly CopyId[],
    ): Promise<CopyReadResult> {
      const accountId = accountIdFrom(context);
      const request = referencesSchema.safeParse(copyIds);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Reads accept at most ${USERCARDS_LIMITS.maxReadReferences} copy references of ` +
            `1 to ${identifierLength} characters.`,
        );
      }

      const requested = distinctReferences(request.data);
      const data = await store.readCopies(accountId, requested);
      const copies = new Map(data.copies.map((copy) => [copy.copyId, copy] as const));
      return {
        privateRevision: data.privateRevision,
        copies,
        missing: requested.filter((copyId) => !copies.has(copyId)),
      };
    },

    async createCopies(
      context: TrustedUserContext,
      input: CreateCopiesInput,
    ): Promise<CopyChangeResult> {
      const accountId = accountIdFrom(context);
      const request = createCopiesRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError('invalid-request', invalidCreateMessage(request.error));
      }
      const { printingId, finish, condition, quantity } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);

      const copies = Array.from({ length: quantity }, () => ({
        copyId: randomUUID(),
        printingId,
        finish,
        condition,
      }));
      const data = await store.insertCopies(accountId, copies);
      return { privateRevision: data.privateRevision, copies: data.copies };
    },

    async correctCopy(
      context: TrustedUserContext,
      input: CorrectCopyInput,
    ): Promise<CopyChangeResult> {
      const accountId = accountIdFrom(context);
      const request = correctCopyRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A correction needs a copy reference, the revision it started from, a printing, a ' +
            'finish and a condition or an explicit unknown condition.',
        );
      }
      const { copyId, expectedRevision, printingId, finish, condition } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);

      const outcome = await store.correctCopy(accountId, {
        copyId,
        expectedRevision,
        printingId,
        finish,
        condition,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError('not-found', 'This account has no copy with that identity.');
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The copy changed after this revision; reload it before correcting it.',
        );
      }
      return { privateRevision: outcome.privateRevision, copies: [outcome.copy] };
    },

    async readTags(context: TrustedUserContext, tagIds: readonly TagId[]): Promise<TagReadResult> {
      const accountId = accountIdFrom(context);
      const request = referencesSchema.safeParse(tagIds);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Reads accept at most ${USERCARDS_LIMITS.maxReadReferences} tag references of ` +
            `1 to ${identifierLength} characters.`,
        );
      }

      const requested = distinctReferences(request.data);
      const data = await organization.readTags(accountId, requested);
      const tags = new Map(data.tags.map((tag) => [tag.tagId, tag] as const));
      return {
        privateRevision: data.privateRevision,
        tags,
        missing: requested.filter((tagId) => !tags.has(tagId)),
      };
    },

    async listTags(
      context: TrustedUserContext,
      options: TagListOptions = {},
    ): Promise<TagListResult> {
      const accountId = accountIdFrom(context);
      const pageSize = options?.pageSize ?? USERCARDS_LIMITS.defaultTagPageSize;
      if (!tagPageSizeSchema.safeParse(pageSize).success) {
        throw new UserCardsError(
          'invalid-request',
          `A tag page size from ${USERCARDS_LIMITS.minTagPageSize} to ` +
            `${USERCARDS_LIMITS.maxTagPageSize} is required.`,
        );
      }
      const continuation =
        options?.continuation === undefined ? null : decodeTagContinuation(options.continuation);
      const offset = continuation?.offset ?? 0;

      const data = await organization.listTags(accountId, offset, pageSize + 1);
      if (continuation !== null && continuation.revision !== data.privateRevision) {
        throw new UserCardsError(
          'conflict',
          'The private data changed after this page was read; start the tag list again.',
        );
      }
      const hasMore = data.tags.length > pageSize;
      return {
        privateRevision: data.privateRevision,
        tags: hasMore ? data.tags.slice(0, pageSize) : data.tags,
        continuation: hasMore
          ? encodeTagContinuation({
              version: 1,
              offset: offset + pageSize,
              revision: data.privateRevision,
            })
          : null,
      };
    },

    async createTag(context: TrustedUserContext, input: CreateTagInput): Promise<TagChangeResult> {
      const accountId = accountIdFrom(context);
      const request = createTagRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `A tag needs one of the kinds ${userTagKinds.join(', ')} and a label of 1 to ` +
            `${identifierLength} characters. The system owned tag is not created here.`,
        );
      }
      const data = await organization.createTag(accountId, {
        tagId: randomUUID(),
        kind: request.data.kind,
        label: request.data.label,
      });
      return { privateRevision: data.privateRevision, tag: data.tag };
    },

    async renameTag(context: TrustedUserContext, input: RenameTagInput): Promise<TagChangeResult> {
      const accountId = accountIdFrom(context);
      const request = renameTagRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A rename needs a tag reference, the revision it started from and a label of ' +
            `1 to ${identifierLength} characters.`,
        );
      }
      const outcome = await organization.correctTag(accountId, request.data);
      if (outcome.outcome === 'missing') {
        throw new UserCardsError('not-found', 'This account has no tag with that identity.');
      }
      if (outcome.outcome === 'system') {
        throw new UserCardsError(
          'invalid-request',
          'System tags are managed through their own lifecycle operations.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The tag changed after this revision; reload it before renaming it.',
        );
      }
      return { privateRevision: outcome.privateRevision, tag: outcome.tag };
    },

    async readAssociations(
      context: TrustedUserContext,
      associationIds: readonly AssociationId[],
    ): Promise<AssociationReadResult> {
      const accountId = accountIdFrom(context);
      const request = referencesSchema.safeParse(associationIds);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Reads accept at most ${USERCARDS_LIMITS.maxReadReferences} association references of ` +
            `1 to ${identifierLength} characters.`,
        );
      }

      const requested = distinctReferences(request.data);
      const data = await organization.readAssociations(accountId, requested);
      const associations = new Map(
        data.associations.map((association) => [association.associationId, association] as const),
      );
      return {
        privateRevision: data.privateRevision,
        associations,
        missing: requested.filter((associationId) => !associations.has(associationId)),
      };
    },

    async createAssociation(
      context: TrustedUserContext,
      input: CreateAssociationInput,
    ): Promise<AssociationChangeResult> {
      const accountId = accountIdFrom(context);
      const request = createAssociationRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError('invalid-request', invalidAssociationMessage());
      }
      const { tagId, targetLevel, targetId } = request.data;

      const tag = await requireTag(organization, accountId, tagId);
      const quantity = associationQuantityFrom(tag.kind, targetLevel, request.data.quantity);
      await requireAssociationTarget(store, catalog, accountId, targetLevel, targetId);

      const outcome = await organization.insertAssociation(accountId, {
        associationId: randomUUID(),
        tagId,
        tagKind: tag.kind,
        targetLevel,
        targetId,
        quantity,
      });
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'This tag already associates that target; change the existing association instead.',
        );
      }
      return { privateRevision: outcome.privateRevision, association: outcome.association };
    },

    async changeAssociation(
      context: TrustedUserContext,
      input: ChangeAssociationInput,
    ): Promise<AssociationChangeResult> {
      const accountId = accountIdFrom(context);
      const request = changeAssociationRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError('invalid-request', invalidAssociationMessage());
      }
      const { associationId, expectedRevision, targetLevel, targetId } = request.data;

      const stored = await requireAssociation(organization, accountId, associationId);
      const tag = await requireTag(organization, accountId, stored.tagId);
      const quantity = associationQuantityFrom(tag.kind, targetLevel, request.data.quantity);
      await requireAssociationTarget(store, catalog, accountId, targetLevel, targetId);

      const outcome = await organization.correctAssociation(accountId, {
        associationId,
        expectedRevision,
        targetLevel,
        targetId,
        quantity,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no association with that identity.',
        );
      }
      if (outcome.outcome === 'duplicate') {
        throw new UserCardsError(
          'conflict',
          'This tag already associates that target in another association.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The association changed after this revision; reload it before changing it.',
        );
      }
      return { privateRevision: outcome.privateRevision, association: outcome.association };
    },

    async removeAssociation(
      context: TrustedUserContext,
      input: RemoveAssociationInput,
    ): Promise<AssociationRemovalResult> {
      const accountId = accountIdFrom(context);
      const request = removeAssociationRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A removal needs an association reference and the revision it started from.',
        );
      }
      const stored = await requireAssociation(organization, accountId, request.data.associationId);
      const tag = await requireTag(organization, accountId, stored.tagId);
      if (tag.kind === 'owned') {
        throw new UserCardsError(
          'invalid-request',
          'System tags are managed through their own lifecycle operations.',
        );
      }
      if (tag.kind === 'location') {
        throw new UserCardsError(
          'invalid-request',
          'A copy’s physical location changes through the copy location operation.',
        );
      }
      const outcome = await organization.removeAssociation(
        accountId,
        stored.associationId,
        request.data.expectedRevision,
      );
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no association with that identity.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The association changed after this revision; reload it before removing it.',
        );
      }
      return { privateRevision: outcome.privateRevision, associationId: outcome.associationId };
    },

    async setCopyLocation(
      context: TrustedUserContext,
      input: SetCopyLocationInput,
    ): Promise<CopyLocationResult> {
      const accountId = accountIdFrom(context);
      const request = setCopyLocationRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A location move needs a copy reference, the revision it started from and a location ' +
            'tag or an explicit absent location.',
        );
      }
      const { copyId, locationTagId, expectedRevision } = request.data;
      if (locationTagId !== null) {
        const location = await requireTag(organization, accountId, locationTagId);
        if (location.kind !== 'location') {
          throw new UserCardsError(
            'invalid-request',
            'A copy’s physical location is a location tag.',
          );
        }
      }

      const outcome = await organization.moveCopyLocation(accountId, {
        copyId,
        expectedRevision,
        locationTagId,
      });
      if (outcome.outcome === 'missing-copy') {
        throw new UserCardsError('not-found', 'This account has no copy with that identity.');
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The copy changed after this revision; reload it before moving it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        copy: outcome.copy,
        location: outcome.location,
      };
    },
  };
}

/** Missing, invalid or empty trusted context never reaches a private record. */
function accountIdFrom(context: TrustedUserContext | undefined): string {
  const parsed = userContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new UserCardsError(
      'invalid-request',
      'Trusted user context with an account identity is required.',
    );
  }
  return parsed.data.accountId;
}

/** Reads each requested reference once, in request order. */
function distinctReferences(references: readonly string[]): string[] {
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (!seen.has(reference)) {
      seen.add(reference);
      requested.push(reference);
    }
  }
  return requested;
}

function invalidCreateMessage(error: z.ZodError): string {
  if (error.issues.some((issue) => issue.path[0] === 'quantity')) {
    return `Each copy request creates 1 to ${USERCARDS_LIMITS.maxCreateQuantity} copies.`;
  }
  return (
    'A copy request needs a printing reference of 1 to ' +
    `${identifierLength} characters, an available finish and a condition or an explicit ` +
    'unknown condition.'
  );
}

function invalidAssociationMessage(): string {
  return (
    'An association needs a tag, a card, printing or copy target of 1 to ' +
    `${identifierLength} characters and, for a card or printing target, an intended quantity ` +
    `from 1 to ${USERCARDS_LIMITS.maxAssociationQuantity}.`
  );
}

/**
 * The quantity one association change carries. Card and printing membership expresses intent and
 * requires a quantity; copy membership is physical and carries none
 * (docs/user-cards.md#records-and-associations). Location membership and ownership are written by
 * their own operations instead of the generic association operations.
 */
function associationQuantityFrom(
  kind: TagKind,
  targetLevel: AssociationTargetLevel,
  quantity: number | null | undefined,
): number | null {
  if (kind === 'owned') {
    throw new UserCardsError(
      'invalid-request',
      'System tags are managed through their own lifecycle operations.',
    );
  }
  if (kind === 'location') {
    throw new UserCardsError(
      'invalid-request',
      'A copy’s physical location changes through the copy location operation.',
    );
  }
  if (!associationLevelsByTagKind[kind].includes(targetLevel)) {
    throw new UserCardsError(
      'invalid-request',
      `A ${kind} tag does not associate ${targetLevel} targets.`,
    );
  }
  if (targetLevel === 'copy') {
    if (quantity !== null && quantity !== undefined) {
      throw new UserCardsError(
        'invalid-request',
        'A copy-targeted association is physical membership and carries no quantity.',
      );
    }
    return null;
  }
  if (quantity === null || quantity === undefined) {
    throw new UserCardsError(
      'invalid-request',
      'A card or printing association needs its intended quantity.',
    );
  }
  return quantity;
}

async function requireTag(
  organization: OrganizationStore,
  accountId: string,
  tagId: string,
): Promise<Tag> {
  const data = await organization.readTags(accountId, [tagId]);
  const tag = data.tags.find((candidate) => candidate.tagId === tagId);
  if (tag === undefined) {
    throw new UserCardsError('not-found', 'This account has no tag with that identity.');
  }
  return tag;
}

async function requireAssociation(
  organization: OrganizationStore,
  accountId: string,
  associationId: string,
): Promise<Association> {
  const data = await organization.readAssociations(accountId, [associationId]);
  const association = data.associations.find(
    (candidate) => candidate.associationId === associationId,
  );
  if (association === undefined) {
    throw new UserCardsError('not-found', 'This account has no association with that identity.');
  }
  return association;
}

/**
 * Resolves the target and validates it before an association is stored: a copy must belong to the
 * account, and a card or printing must exist in the published catalog. Another account's copy is
 * missing exactly like a copy that never existed (docs/user-cards.md#interface).
 */
async function requireAssociationTarget(
  store: CopyStore,
  catalog: Catalog,
  accountId: string,
  targetLevel: AssociationTargetLevel,
  targetId: string,
): Promise<void> {
  if (targetLevel === 'copy') {
    const data = await store.readCopies(accountId, [targetId]);
    if (!data.copies.some((copy) => copy.copyId === targetId)) {
      throw new UserCardsError('not-found', 'This account has no copy with that identity.');
    }
    return;
  }
  const resolution = await resolveCatalog(
    catalog,
    targetLevel === 'card'
      ? [{ kind: 'card', cardId: targetId }]
      : [{ kind: 'printing', printingId: targetId }],
  );
  const found =
    targetLevel === 'card' ? resolution.cards.has(targetId) : resolution.printings.has(targetId);
  if (!found) {
    throw new UserCardsError(
      'not-found',
      targetLevel === 'card'
        ? 'The card is not available in the catalog.'
        : 'The printing is not available in the catalog.',
    );
  }
}

/**
 * Resolves the printing in the published catalog and validates the physical attributes a copy
 * would store: the printing must exist, be available as a physical card and offer that finish.
 */
async function resolvePhysicalPrinting(
  catalog: Catalog,
  printingId: string,
  finish: Finish,
): Promise<void> {
  const resolution = await resolveCatalog(catalog, [{ kind: 'printing', printingId }]);
  const printing = resolution.printings.get(printingId);
  if (printing === undefined) {
    throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
  }
  if (!printing.physical) {
    throw new UserCardsError(
      'invalid-request',
      'The printing is not available as a physical card.',
    );
  }
  if (!printing.finishes.includes(finish)) {
    throw new UserCardsError(
      'invalid-request',
      `The printing is not available in the ${finish} finish.`,
    );
  }
}

/** A catalog read failure is a temporary failure, never a missing reference. */
async function resolveCatalog(
  catalog: Catalog,
  references: readonly CatalogReference[],
): Promise<CatalogResolution> {
  try {
    return await catalog.resolve(references);
  } catch (cause) {
    if (cause instanceof CatalogError) {
      throw new UserCardsError(
        'unavailable',
        'The catalog could not be read to validate the reference.',
        { cause },
      );
    }
    throw cause;
  }
}

function encodeTagContinuation(payload: TagContinuationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeTagContinuation(token: string): TagContinuationPayload {
  const unreadable = new UserCardsError(
    'invalid-request',
    'This continuation is not readable; start the tag list again.',
  );
  if (typeof token !== 'string' || token.length === 0 || token.length > maxTagContinuationLength) {
    throw unreadable;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw unreadable;
  }
  const parsed = tagContinuationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unreadable;
  }
  return parsed.data;
}
