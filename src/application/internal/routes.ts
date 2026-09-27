/**
 * The backend operations Application dispatches (docs/application.md#interface).
 *
 * Every route validates its transport input, derives the trusted context from the verified
 * identity and hands the request to its owning component. Private routes never run anonymously,
 * catalog synchronization has no route at all (it is a separate job entry point) and the
 * recognition compute entry point is a separate runtime: only its paths reach the browser through
 * the authenticated client. Success returns the component's result; a failure keeps its code.
 */

import { z } from 'zod';

import type { Catalog, CatalogReference, CatalogResolution } from '../../catalog/index.js';
import type { Search, SearchRequestInput } from '../../search/index.js';
import type {
  AssociationId,
  AssociationReadResult,
  AttachImportCandidatesInput,
  ChangeAssociationInput,
  ConfirmImportInput,
  CopyId,
  CopyReadResult,
  CorrectCopyInput,
  CreateAssociationInput,
  CreateCopiesInput,
  CreateTagInput,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
  RemoveAssociationInput,
  RenameTagInput,
  ReviewImportEntryInput,
  SetCopyLocationInput,
  StageCaptureInput,
  StageImportEntriesInput,
  StageSourceImportInput,
  TagId,
  TagListOptions,
  TagReadResult,
  TrustedUserContext,
  UserCards,
  SourceImportOperations,
} from '../../usercards/index.js';

import { ApplicationError } from './failures.js';
import { applicationRoutes } from './paths.js';
import {
  findPreservedPrinting,
  readPreservedCardQuery,
  readPreservedSearchQuery,
  resolvePreservedPrinting,
} from './preserved-catalog.js';
import type { Route, RouteCall } from './transport.js';

/** Everything the route table dispatches to; each contract stays provider-owned. */
export interface RouteDependencies {
  readonly catalog: Catalog;
  readonly search: Search;
  readonly userCards: UserCards;
  /** Source-import operations, or null when the deployment disabled the capability. */
  readonly sourceImports: SourceImportOperations | null;
}

const pageQuerySchema = z.object({
  pageSize: z.coerce.number().int().optional(),
  continuation: z.string().min(1).optional(),
});

/** The whole interactive surface, in one place so both runtimes and the tests share it. */
export function createRoutes(dependencies: RouteDependencies): readonly Route[] {
  const { catalog, search, userCards, sourceImports } = dependencies;

  return [
    {
      operation: 'catalog.resolve',
      method: 'POST',
      path: applicationRoutes.catalogResolve,
      access: 'public',
      call: async ({ body }) => {
        const resolution = await catalog.resolve(body.references as readonly CatalogReference[]);
        return catalogResolutionPayload(resolution);
      },
    },
    {
      operation: 'catalog.listCardPrintings',
      method: 'GET',
      path: applicationRoutes.catalogCardPrintings,
      access: 'public',
      call: ({ params, query }) =>
        catalog.listCardPrintings(readParam(params, 'cardId'), readPageQuery(query)),
    },
    {
      operation: 'search.execute',
      method: 'POST',
      path: applicationRoutes.search,
      access: 'public',
      call: ({ body, context }) => search.execute(body as unknown as SearchRequestInput, context),
    },
    {
      // The preserved browser engines hydrate a candidate through their own envelope; the new
      // request model never sees this lookup (docs/recognition.md#interface).
      operation: 'catalog.preservedCard',
      method: 'GET',
      path: applicationRoutes.preservedCard,
      access: 'public',
      call: async ({ query }) => {
        const printing = await resolvePreservedPrinting(catalog, readPreservedCardQuery(query));
        return { cards: printing === null ? [] : [printing] };
      },
    },
    {
      // The preserved resolution asks for one translated printing in a narrow Scryfall subset.
      operation: 'catalog.preservedSearch',
      method: 'GET',
      path: applicationRoutes.search,
      access: 'public',
      call: async ({ query }) => {
        const printing = await findPreservedPrinting(catalog, readPreservedSearchQuery(query));
        return { cards: printing === null ? [] : [printing] };
      },
    },
    {
      operation: 'usercards.readCopies',
      method: 'POST',
      path: applicationRoutes.copiesRead,
      access: 'authenticated',
      call: async (call) =>
        copyReadPayload(await userCards.readCopies(context(call), readCopyIds(call))),
    },
    {
      operation: 'usercards.createCopies',
      method: 'POST',
      path: applicationRoutes.copies,
      access: 'authenticated',
      call: (call) =>
        userCards.createCopies(context(call), call.body as unknown as CreateCopiesInput),
    },
    {
      operation: 'usercards.correctCopy',
      method: 'POST',
      path: applicationRoutes.copyCorrections,
      access: 'authenticated',
      call: (call) =>
        userCards.correctCopy(context(call), {
          ...call.body,
          copyId: readParam(call.params, 'copyId'),
        } as unknown as CorrectCopyInput),
    },
    {
      operation: 'usercards.setCopyLocation',
      method: 'POST',
      path: applicationRoutes.copyLocation,
      access: 'authenticated',
      call: (call) =>
        userCards.setCopyLocation(context(call), {
          ...call.body,
          copyId: readParam(call.params, 'copyId'),
        } as unknown as SetCopyLocationInput),
    },
    {
      operation: 'usercards.listTags',
      method: 'GET',
      path: applicationRoutes.tags,
      access: 'authenticated',
      call: (call) =>
        userCards.listTags(context(call), readPageQuery(call.query) as TagListOptions),
    },
    {
      operation: 'usercards.readTags',
      method: 'POST',
      path: applicationRoutes.tagsRead,
      access: 'authenticated',
      call: async (call) =>
        tagReadPayload(
          await userCards.readTags(context(call), call.body.tagIds as readonly TagId[]),
        ),
    },
    {
      operation: 'usercards.createTag',
      method: 'POST',
      path: applicationRoutes.tags,
      access: 'authenticated',
      call: (call) => userCards.createTag(context(call), call.body as unknown as CreateTagInput),
    },
    {
      operation: 'usercards.renameTag',
      method: 'POST',
      path: applicationRoutes.tagRename,
      access: 'authenticated',
      call: (call) =>
        userCards.renameTag(context(call), {
          ...call.body,
          tagId: readParam(call.params, 'tagId'),
        } as unknown as RenameTagInput),
    },
    {
      operation: 'usercards.readAssociations',
      method: 'POST',
      path: applicationRoutes.associationsRead,
      access: 'authenticated',
      call: async (call) =>
        associationReadPayload(
          await userCards.readAssociations(
            context(call),
            call.body.associationIds as readonly AssociationId[],
          ),
        ),
    },
    {
      operation: 'usercards.createAssociation',
      method: 'POST',
      path: applicationRoutes.associations,
      access: 'authenticated',
      call: (call) =>
        userCards.createAssociation(context(call), call.body as unknown as CreateAssociationInput),
    },
    {
      operation: 'usercards.changeAssociation',
      method: 'POST',
      path: applicationRoutes.associationChanges,
      access: 'authenticated',
      call: (call) =>
        userCards.changeAssociation(context(call), {
          ...call.body,
          associationId: readParam(call.params, 'associationId'),
        } as unknown as ChangeAssociationInput),
    },
    {
      operation: 'usercards.removeAssociation',
      method: 'POST',
      path: applicationRoutes.associationRemoval,
      access: 'authenticated',
      call: (call) =>
        userCards.removeAssociation(context(call), {
          ...call.body,
          associationId: readParam(call.params, 'associationId'),
        } as unknown as RemoveAssociationInput),
    },
    {
      operation: 'usercards.listImportSessions',
      method: 'GET',
      path: applicationRoutes.imports,
      access: 'authenticated',
      call: (call) =>
        userCards.listImportSessions(
          context(call),
          readPageQuery(call.query) as ListImportSessionsOptions,
        ),
    },
    {
      operation: 'usercards.recoverImportOperation',
      method: 'GET',
      path: applicationRoutes.importOperation,
      access: 'authenticated',
      call: (call) =>
        userCards.recoverImportOperation(context(call), readParam(call.params, 'operationId')),
    },
    {
      operation: 'usercards.stageSourceImport',
      method: 'POST',
      path: applicationRoutes.importSources,
      access: 'authenticated',
      call: (call) => {
        if (sourceImports === null) {
          throw new ApplicationError(
            'unavailable',
            'Source imports are not enabled in this environment.',
          );
        }
        return sourceImports.stageSourceImport(
          context(call),
          call.body as unknown as StageSourceImportInput,
        );
      },
    },
    {
      operation: 'usercards.listImportEntries',
      method: 'GET',
      path: applicationRoutes.importEntries,
      access: 'authenticated',
      call: (call) =>
        userCards.listImportEntries(context(call), {
          ...readPageQuery(call.query),
          sessionId: readParam(call.params, 'sessionId'),
        } as unknown as ListImportEntriesOptions),
    },
    {
      operation: 'usercards.stageImportEntries',
      method: 'POST',
      path: applicationRoutes.importEntries,
      access: 'authenticated',
      call: (call) =>
        userCards.stageImportEntries(context(call), {
          ...call.body,
          sessionId: readParam(call.params, 'sessionId'),
        } as unknown as StageImportEntriesInput),
    },
    {
      operation: 'usercards.stageCaptureObservation',
      method: 'POST',
      path: applicationRoutes.importCaptures,
      access: 'authenticated',
      call: (call) =>
        userCards.stageCaptureObservation(context(call), {
          ...call.body,
          sessionId: readParam(call.params, 'sessionId'),
        } as unknown as StageCaptureInput),
    },
    {
      operation: 'usercards.discardImportSession',
      method: 'POST',
      path: applicationRoutes.importDiscard,
      access: 'authenticated',
      call: (call) =>
        userCards.discardImportSession(context(call), {
          ...call.body,
          sessionId: readParam(call.params, 'sessionId'),
        } as unknown as DiscardImportSessionInput),
    },
    {
      operation: 'usercards.confirmImport',
      method: 'POST',
      path: applicationRoutes.importConfirmation,
      access: 'authenticated',
      replayOperationId: (call) => readOperationId(call.body),
      call: (call) =>
        userCards.confirmImport(context(call), {
          ...call.body,
          sessionId: readParam(call.params, 'sessionId'),
        } as unknown as ConfirmImportInput),
    },
    {
      operation: 'usercards.reviewImportEntry',
      method: 'POST',
      path: applicationRoutes.importEntryReview,
      access: 'authenticated',
      call: (call) =>
        userCards.reviewImportEntry(context(call), {
          ...call.body,
          entryId: readParam(call.params, 'entryId'),
        } as unknown as ReviewImportEntryInput),
    },
    {
      operation: 'usercards.attachImportCandidates',
      method: 'POST',
      path: applicationRoutes.importEntryCandidates,
      access: 'authenticated',
      call: (call) =>
        userCards.attachImportCandidates(context(call), {
          ...call.body,
          entryId: readParam(call.params, 'entryId'),
        } as unknown as AttachImportCandidatesInput),
    },
    {
      operation: 'usercards.discardImportEntry',
      method: 'POST',
      path: applicationRoutes.importEntryDiscard,
      access: 'authenticated',
      call: (call) =>
        userCards.discardImportEntry(context(call), {
          ...call.body,
          entryId: readParam(call.params, 'entryId'),
        } as unknown as DiscardImportEntryInput),
    },
  ];
}

/** The trusted context of an authenticated route; the router never calls one without it. */
function context(call: RouteCall): TrustedUserContext {
  if (call.context === null) {
    throw new ApplicationError('unauthorized', 'Sign in to use the collection.');
  }
  return call.context;
}

function readCopyIds(call: RouteCall): readonly CopyId[] {
  return call.body.copyIds as readonly CopyId[];
}

function readParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApplicationError('invalid-request', `The ${name} path segment is required.`);
  }
  return value;
}

function readPageQuery(query: Readonly<Record<string, string | undefined>>): {
  readonly pageSize?: number;
  readonly continuation?: string;
} {
  const parsed = pageQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new ApplicationError('invalid-request', 'The request page boundary is invalid.');
  }
  return parsed.data;
}

function readOperationId(body: Readonly<Record<string, unknown>>): string | null {
  const operationId = body.operationId;
  return typeof operationId === 'string' && operationId.length > 0 ? operationId : null;
}

/** Serializes a catalog resolution: the record maps become ordered arrays on the wire. */
function catalogResolutionPayload(resolution: CatalogResolution): unknown {
  return {
    revision: resolution.revision,
    cards: [...resolution.cards.values()],
    printings: [...resolution.printings.values()],
    missing: resolution.missing,
  };
}

function copyReadPayload(result: CopyReadResult): unknown {
  return {
    privateRevision: result.privateRevision,
    copies: [...result.copies.values()],
    missing: result.missing,
  };
}

function tagReadPayload(result: TagReadResult): unknown {
  return {
    privateRevision: result.privateRevision,
    tags: [...result.tags.values()],
    missing: result.missing,
  };
}

function associationReadPayload(result: AssociationReadResult): unknown {
  return {
    privateRevision: result.privateRevision,
    associations: [...result.associations.values()],
    missing: result.missing,
  };
}
