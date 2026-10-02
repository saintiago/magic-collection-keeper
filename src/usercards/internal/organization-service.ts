import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type CatalogResolver } from '../../catalog/index.js';
import { resolveCatalog } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  associationTargetLevels,
  userTagKinds,
  type Association,
  type AssociationId,
  type AssociationTargetLevel,
  type Tag,
  type TagId,
  type TagKind,
  type TrustedUserContext,
} from './model.js';
import { decodeContinuation, encodeContinuation } from './pagination.js';
import type {
  AssociationListResult,
  AssociationChangeResult,
  AssociationReadResult,
  AssociationRemovalResult,
  ChangeAssociationInput,
  CopyLocationResult,
  CreateAssociationInput,
  CreateTagInput,
  ListAssociationsOptions,
  RemoveAssociationInput,
  RenameTagInput,
  SetCopyLocationInput,
  TagChangeResult,
  TagListOptions,
  TagListResult,
  TagReadResult,
  UserCards,
} from './records-contract.js';
import {
  distinctReferences,
  identifierLength,
  referenceSchema,
  referencesSchema,
  revisionSchema,
} from './record-validation.js';
import type { CopyStore, OrganizationStore } from './store.js';

const labelSchema = z.string().min(1).max(identifierLength);

const quantitySchema = z
  .number()
  .int()
  .min(1)
  .max(USERCARDS_LIMITS.maxAssociationQuantity)
  .nullable()
  .optional();

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

const associationPageSizeSchema = z
  .number()
  .int()
  .min(USERCARDS_LIMITS.minAssociationPageSize)
  .max(USERCARDS_LIMITS.maxAssociationPageSize);

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
  catalog: CatalogResolver,
  accountId: string,
  targetLevel: AssociationTargetLevel,
  targetId: string,
): Promise<string | null> {
  if (targetLevel === 'copy') {
    const data = await store.readCopies(accountId, [targetId]);
    if (!data.copies.some((copy) => copy.copyId === targetId)) {
      throw new UserCardsError('not-found', 'This account has no copy with that identity.');
    }
    return null;
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
  return targetLevel === 'card' ? targetId : (resolution.printings.get(targetId)?.cardId ?? null);
}

export function createOrganizationOperations(dependencies: {
  readonly store: CopyStore;
  readonly organization: OrganizationStore;
  readonly catalog: CatalogResolver;
}): Pick<
  UserCards,
  | 'readTags'
  | 'listTags'
  | 'createTag'
  | 'renameTag'
  | 'readAssociations'
  | 'listAssociations'
  | 'createAssociation'
  | 'changeAssociation'
  | 'removeAssociation'
  | 'setCopyLocation'
> {
  const { store, organization, catalog } = dependencies;
  return {
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
        options?.continuation === undefined
          ? null
          : decodeContinuation(
              options.continuation,
              'This continuation is not readable; start the tag list again.',
            );
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
          ? encodeContinuation({
              version: 1,
              offset: offset + pageSize,
              revision: data.privateRevision,
            })
          : null,
      };
    },
    /**
     * Lists one page of one tag's associations, ordered by stable association identity. A tag this
     * account does not own has no associations to publish, and the page carries the identity and
     * revision the tag view quotes when it changes an intended quantity or refines a target level
     * (docs/user-cards.md#records-and-associations).
     */
    async listAssociations(
      context: TrustedUserContext,
      options: ListAssociationsOptions,
    ): Promise<AssociationListResult> {
      const accountId = accountIdFrom(context);
      const tagId = options?.tagId;
      if (!referenceSchema.safeParse(tagId).success) {
        throw new UserCardsError(
          'invalid-request',
          `A tag reference of 1 to ${identifierLength} characters is required.`,
        );
      }
      const pageSize = options?.pageSize ?? USERCARDS_LIMITS.defaultAssociationPageSize;
      if (!associationPageSizeSchema.safeParse(pageSize).success) {
        throw new UserCardsError(
          'invalid-request',
          `An association page size from ${USERCARDS_LIMITS.minAssociationPageSize} to ` +
            `${USERCARDS_LIMITS.maxAssociationPageSize} is required.`,
        );
      }
      const continuation =
        options?.continuation === undefined
          ? null
          : decodeContinuation(
              options.continuation,
              'This continuation is not readable; start the association list again.',
            );
      const offset = continuation?.offset ?? 0;

      const data = await organization.listAssociations(accountId, tagId, offset, pageSize + 1);
      if (continuation !== null && continuation.revision !== data.privateRevision) {
        throw new UserCardsError(
          'conflict',
          'The private data changed after this page was read; start the association list again.',
        );
      }
      const hasMore = data.associations.length > pageSize;
      return {
        privateRevision: data.privateRevision,
        associations: hasMore ? data.associations.slice(0, pageSize) : data.associations,
        continuation: hasMore
          ? encodeContinuation({
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
      return {
        privateRevision: data.privateRevision,

        tag: data.tag,
      };
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
      return {
        privateRevision: outcome.privateRevision,

        tag: outcome.tag,
      };
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
      const cardId = await requireAssociationTarget(
        store,
        catalog,
        accountId,
        targetLevel,
        targetId,
      );

      const outcome = await organization.insertAssociation(accountId, {
        associationId: randomUUID(),
        tagId,
        tagKind: tag.kind,
        targetLevel,
        targetId,
        cardId: targetLevel === 'printing' ? cardId : null,
        quantity,
      });
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'This tag already associates that target; change the existing association instead.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,

        association: outcome.association,
      };
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
      const cardId = await requireAssociationTarget(
        store,
        catalog,
        accountId,
        targetLevel,
        targetId,
      );

      const outcome = await organization.correctAssociation(accountId, {
        associationId,
        expectedRevision,
        targetLevel,
        targetId,
        cardId: targetLevel === 'printing' ? cardId : null,
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
      return {
        privateRevision: outcome.privateRevision,

        association: outcome.association,
      };
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
      return {
        privateRevision: outcome.privateRevision,

        associationId: outcome.associationId,
      };
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
