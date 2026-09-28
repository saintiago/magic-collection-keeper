/**
 * The browser side of the transports (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The authenticated request attaches the caller's current identity to every backend call, routes
 * the preserved recognition calls to the compute entry point and everything else to the interactive
 * entry point, and rejects a response that belongs to a session that already ended. The catalog
 * and search clients and the browser application compose the component contracts the UserInterface
 * receives; only public settings cross into the browser. Application's own failure envelope keeps
 * its code and message; the preserved compute runtime reports a plain message beside the HTTP
 * status, so that status decides the failure instead of collapsing into an invalid request.
 */

// A type-only import of the Catalog public entry keeps the provider barrel out of a browser
// bundle: the inline `type` form would stay behind as an evaluated empty import (docs/application.md#interface).
import type {
  CardRecord,
  CardPrintingsPage,
  Catalog,
  CatalogReference,
  CatalogResolution,
  CatalogRevision,
  ListCardPrintingsOptions,
  PrintingRecord,
} from '../../catalog/index.js';
import {
  createRecognition,
  createBrowserRecognitionPipeline,
  type Recognition,
  type RecognitionFrameFacts,
} from '../../recognition/index.js';
// Search stays a type-only import here for the same reason: the browser reaches its contract
// through the request it already carries (docs/application.md#interface).
import type {
  SearchCount,
  SearchCountInput,
  SearchCountResult,
  SearchEntry,
  SearchEntryTarget,
  SearchPage,
  SearchRequestInput,
  SearchRevisions,
} from '../../search/index.js';
// UserCards follows the same rule: the collection views reach its private operations through this
// authenticated contract, and a value import would pull the component's Node-only internals into
// the browser bundle.
import type {
  Association,
  AssociationChangeResult,
  AssociationListResult,
  AssociationReadResult,
  AssociationRemovalResult,
  AttachImportCandidatesInput,
  CaptureStageResult,
  ChangeAssociationInput,
  ConfirmImportInput,
  CopyChangeResult,
  CopyLocationResult,
  CopyId,
  CopyReadResult,
  CorrectCopyInput,
  CreateAssociationInput,
  CreateTagInput,
  DiscardImportEntryInput,
  DiscardImportSessionInput,
  ImportCandidate,
  ImportConfirmationResult,
  ImportEntry,
  ImportEntryChangeResult,
  ImportEntryListResult,
  ImportEntryState,
  ImportOperationRecoveryResult,
  ImportReceipt,
  ImportSession,
  ImportSessionChange,
  ImportSessionListResult,
  ImportSourceLine,
  ImportStageResult,
  ListAssociationsOptions,
  ListImportEntriesOptions,
  ListImportSessionsOptions,
  PhysicalCopy,
  RemoveAssociationInput,
  RenameTagInput,
  ReviewImportEntryInput,
  SetCopyLocationInput,
  SourceImportOutcome,
  SourceImportResult,
  SourceImportRow,
  StageCaptureInput,
  StageImportEntriesInput,
  StageSourceImportInput,
  Tag,
  TagChangeResult,
  TagListOptions,
  TagListResult,
  TagReadResult,
} from '../../usercards/index.js';

import {
  isApplicationFailureCode,
  ApplicationError,
  type ApplicationFailureCode,
} from './failures.js';
import {
  createBrowserAuthentication,
  type BrowserCredentialPrompt,
  type BrowserIdentity,
  type BrowserSessionStore,
} from './browser-authentication.js';
import { resolvePublicSettings, type PublicApplicationSettings } from './configuration.js';
import { applicationRoutes } from './paths.js';
import { applicationPath } from './transport.js';

/** The preserved engines' inference paths reach the recognition compute entry point. */
const computePaths: readonly string[] = [
  applicationRoutes.recognition,
  applicationRoutes.recognitionIndependent,
];

export interface AuthenticatedRequestInit {
  readonly method?: string;
  readonly body?: string;
  readonly signal?: AbortSignal | null;
}

/** The callable part of a transport: everything a consumer needs to reach one entry point. */
export type RequestTransport = (path: string, init?: AuthenticatedRequestInit) => Promise<unknown>;

/**
 * One authenticated request to a backend entry point. A caller that has no current identity, or
 * whose session ended while the response was on its way, receives an `unauthorized` failure instead
 * of another session's data.
 */
export interface AuthenticatedRequest extends RequestTransport {
  /** Ends the current session; a response of it is rejected instead of delivered. */
  endSession(): void;
}

export interface AuthenticatedRequestOptions {
  /** Base URL of the entry point; the request path is appended. */
  readonly baseUrl: string;
  /** Supplies the current ID token, null when signed out, or throws when acquisition is unavailable. */
  readonly token: () => string | null | Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Builds the authenticated transport one entry point is reached through. */
export function createAuthenticatedRequest(
  options: AuthenticatedRequestOptions,
): AuthenticatedRequest {
  const baseUrl = readBaseUrl(options?.baseUrl);
  const token = options?.token;
  if (typeof token !== 'function') {
    throw new TypeError('createAuthenticatedRequest requires a token provider.');
  }
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createAuthenticatedRequest requires a fetch implementation.');
  }
  let session = 0;

  const request = (async (path: string, init: AuthenticatedRequestInit = {}) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('An authenticated request names its path.');
    }
    const opened = session;
    const credential = await readCredential(token);
    if (opened !== session) {
      throw new ApplicationError('unauthorized', 'The session ended before the request was sent.');
    }
    if (isAborted(init.signal)) {
      throw new ApplicationError('cancelled', 'The invocation was cancelled.');
    }
    let response: Response;
    try {
      response = await fetchImpl(joinBaseUrl(baseUrl, path), {
        method: init.method ?? 'GET',
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: init.signal ?? undefined,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
      });
    } catch (cause) {
      if (isAborted(init.signal)) {
        throw new ApplicationError('cancelled', 'The invocation was cancelled.', { cause });
      }
      throw new ApplicationError('unavailable', 'The service could not be reached.', { cause });
    }
    const payload = await readPayload(response, init.signal);
    if (opened !== session) {
      throw new ApplicationError('unauthorized', 'The session ended before the response arrived.');
    }
    if (!response.ok) {
      throw readFailure(response.status, payload);
    }
    return payload;
  }) as AuthenticatedRequest;

  request.endSession = () => {
    session += 1;
  };
  return request;
}

/**
 * A Catalog contract over the interactive entry point. The preserved recognition resolution and the
 * UserInterface read the published catalog through it instead of reaching the provider directly.
 */
export function createCatalogClient(request: RequestTransport): Catalog {
  if (typeof request !== 'function') {
    throw new TypeError('createCatalogClient requires the authenticated request contract.');
  }
  return {
    async resolve(references: readonly CatalogReference[]): Promise<CatalogResolution> {
      const payload = await request(applicationRoutes.catalogResolve, {
        method: 'POST',
        body: JSON.stringify({ references }),
      });
      return readCatalogResolution(payload);
    },

    async listCardPrintings(
      cardId: string,
      options: ListCardPrintingsOptions = {},
    ): Promise<CardPrintingsPage> {
      const path = withQuery(applicationPath(applicationRoutes.catalogCardPrintings, { cardId }), {
        pageSize: options.pageSize,
        continuation: options.continuation,
      });
      return readPrintingsPage(cardId, await request(path));
    },
  };
}

/**
 * The Search contract over the interactive entry point. The caller sends its request; the
 * transport derives the trusted account from the verified identity, so no account crosses into the
 * browser and a private query is authorized at the backend boundary. A page keeps the provider's
 * result unchanged: stable entry keys, typed targets, basic information, quantity context and the
 * opaque continuation of the query.
 */
export interface SearchClient {
  /** Evaluates one request; an aborted signal withdraws the invocation. */
  execute(request: SearchRequestInput, signal?: AbortSignal): Promise<SearchPage>;
  /**
   * Reads the account's private counts of explicit references: owned copies, the distinct physical
   * locations holding them and one tag's intended quantity covering each reference. The read
   * enriches presented entries without changing which entries a query selected.
   */
  counts(request: SearchCountInput, signal?: AbortSignal): Promise<SearchCountResult>;
}

/** Builds the Search contract the UserInterface queries through the interactive entry point. */
export function createSearchClient(request: RequestTransport): SearchClient {
  if (typeof request !== 'function') {
    throw new TypeError('createSearchClient requires the authenticated request contract.');
  }
  return {
    async execute(input: SearchRequestInput, signal?: AbortSignal): Promise<SearchPage> {
      const payload = await request(applicationRoutes.search, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readSearchPage(payload);
    },

    async counts(input: SearchCountInput, signal?: AbortSignal): Promise<SearchCountResult> {
      const payload = await request(applicationRoutes.searchCounts, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readSearchCountResult(payload);
    },
  };
}

/**
 * The private UserCards operations the UserInterface presents
 * (docs/user-interface.md#interface, docs/user-cards.md#interface). The caller sends explicit copy
 * or tag references and the change it read them from; the transport derives the trusted account
 * from the verified identity, so no account crosses into the browser and every private read and
 * change is scoped to the caller at the backend boundary. Tags are read as bounded pages, a tag's
 * associations are listed under the same rule, copy corrections and association changes quote the
 * revision the caller read, and an operation that leaves records unchanged reports its failure
 * instead of an empty success. A query-visible change carries the durable publication position
 * its records were published at, and a recovered confirmation reports the position its copies
 * were published at (docs/user-cards.md#query-surface). Pending imports are read as bounded
 * session and entry pages, a staged line, review or discard quotes the entry identity the caller
 * read, and a confirmation carries the operation identity a retry or recovery refers to
 * (docs/user-cards.md#import-and-capture-state).
 */
export interface UserCardsClient {
  /** Authorized copies of the requested references, with the references this account has none for. */
  readCopies(copyIds: readonly CopyId[], signal?: AbortSignal): Promise<CopyReadResult>;
  /** The corrected state of one copy, guarded by the revision the caller read. */
  correctCopy(input: CorrectCopyInput, signal?: AbortSignal): Promise<CopyChangeResult>;
  /** Page of the account's tags, ordered by stable tag identity. */
  listTags(options?: TagListOptions, signal?: AbortSignal): Promise<TagListResult>;
  /** Authorized tags of the requested references, with the references this account has none for. */
  readTags(tagIds: readonly string[], signal?: AbortSignal): Promise<TagReadResult>;
  /** One new tag of the account. */
  createTag(input: CreateTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  /** The renamed state of one tag, guarded by the revision the caller read. */
  renameTag(input: RenameTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  /** Page of one tag's associations, ordered by stable association identity. */
  listAssociations(
    tagId: string,
    options?: Omit<ListAssociationsOptions, 'tagId'>,
    signal?: AbortSignal,
  ): Promise<AssociationListResult>;
  /** Authorized associations of the requested references, for reviewing a change's outcome. */
  readAssociations(
    associationIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssociationReadResult>;
  /** One new association of a tag; a card or printing target carries its intended quantity. */
  createAssociation(
    input: CreateAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  /** The changed state of one association, guarded by the revision the caller read. */
  changeAssociation(
    input: ChangeAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  /** The removal of one association, guarded by the revision the caller read. */
  removeAssociation(
    input: RemoveAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationRemovalResult>;
  /** The new single physical location of one copy, guarded by the revision the caller read. */
  setCopyLocation(input: SetCopyLocationInput, signal?: AbortSignal): Promise<CopyLocationResult>;
  /** Page of the account's pending import sessions, ordered by stable session identity. */
  listImportSessions(
    options?: ListImportSessionsOptions,
    signal?: AbortSignal,
  ): Promise<ImportSessionListResult>;
  /** Page of one pending import session's entries, in capture order. */
  listImportEntries(
    input: ListImportEntriesOptions,
    signal?: AbortSignal,
  ): Promise<ImportEntryListResult>;
  /** Stages parsed or manually entered lines as pending entries of one session. */
  stageImportEntries(
    input: StageImportEntriesInput,
    signal?: AbortSignal,
  ): Promise<ImportStageResult>;
  /**
   * Parses one supported source into the account's pending entries and reports what each parsed
   * row became, including the rows that staged nothing
   * (docs/user-cards.md#source-imports).
   */
  stageSourceImport(
    input: StageSourceImportInput,
    signal?: AbortSignal,
  ): Promise<SourceImportResult>;
  /**
   * Stages one capture observation as a pending entry of its capture session, or reports the
   * admission decision the session's accepted identity produced
   * (docs/user-cards.md#import-and-capture-state).
   */
  stageCaptureObservation(
    input: StageCaptureInput,
    signal?: AbortSignal,
  ): Promise<CaptureStageResult>;
  /** One pending entry's reviewed values, guarded by the revision the caller read. */
  reviewImportEntry(
    input: ReviewImportEntryInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Late recognition alternatives of one pending entry; reviewed values stay unchanged. */
  attachImportCandidates(
    input: AttachImportCandidatesInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Ends one pending entry without creating owned copies. */
  discardImportEntry(
    input: DiscardImportEntryInput,
    signal?: AbortSignal,
  ): Promise<ImportEntryChangeResult>;
  /** Ends every pending entry of one import without creating owned copies. */
  discardImportSession(
    input: DiscardImportSessionInput,
    signal?: AbortSignal,
  ): Promise<ImportSessionChange>;
  /** Confirms reviewed entries under one operation identity, creating their copies. */
  confirmImport(input: ConfirmImportInput, signal?: AbortSignal): Promise<ImportConfirmationResult>;
  /** The recorded outcome of one operation identity, or its explicit absence. */
  recoverImportOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ImportOperationRecoveryResult>;
}

/** Builds the private contract the collection, organization and import views read and change through. */
export function createUserCardsClient(request: RequestTransport): UserCardsClient {
  if (typeof request !== 'function') {
    throw new TypeError('createUserCardsClient requires the authenticated request contract.');
  }
  return {
    async readCopies(copyIds: readonly CopyId[], signal?: AbortSignal): Promise<CopyReadResult> {
      const payload = await request(applicationRoutes.copiesRead, {
        method: 'POST',
        body: JSON.stringify({ copyIds }),
        ...(signal === undefined ? {} : { signal }),
      });
      return readCopyReadResult(payload);
    },

    async correctCopy(input: CorrectCopyInput, signal?: AbortSignal): Promise<CopyChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.copyCorrections, { copyId: input.copyId }),
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            printingId: input.printingId,
            finish: input.finish,
            condition: input.condition,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readCopyChangeResult(payload);
    },

    async listTags(options: TagListOptions = {}, signal?: AbortSignal): Promise<TagListResult> {
      const path = withQuery(applicationRoutes.tags, {
        pageSize: options.pageSize,
        continuation: options.continuation,
      });
      return readTagListResult(await request(path, signal === undefined ? {} : { signal }));
    },

    async readTags(tagIds: readonly string[], signal?: AbortSignal): Promise<TagReadResult> {
      const payload = await request(applicationRoutes.tagsRead, {
        method: 'POST',
        body: JSON.stringify({ tagIds }),
        ...(signal === undefined ? {} : { signal }),
      });
      return readTagReadResult(payload);
    },

    async createTag(input: CreateTagInput, signal?: AbortSignal): Promise<TagChangeResult> {
      const payload = await request(applicationRoutes.tags, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readTagChangeResult(payload);
    },

    async renameTag(input: RenameTagInput, signal?: AbortSignal): Promise<TagChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.tagRename, { tagId: input.tagId }),
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            label: input.label,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readTagChangeResult(payload);
    },

    async listAssociations(
      tagId: string,
      options: Omit<ListAssociationsOptions, 'tagId'> = {},
      signal?: AbortSignal,
    ): Promise<AssociationListResult> {
      const path = withQuery(applicationPath(applicationRoutes.tagAssociations, { tagId }), {
        pageSize: options.pageSize,
        continuation: options.continuation,
      });
      return readAssociationListResult(await request(path, signal === undefined ? {} : { signal }));
    },

    async readAssociations(
      associationIds: readonly string[],
      signal?: AbortSignal,
    ): Promise<AssociationReadResult> {
      const payload = await request(applicationRoutes.associationsRead, {
        method: 'POST',
        body: JSON.stringify({ associationIds }),
        ...(signal === undefined ? {} : { signal }),
      });
      return readAssociationReadResult(payload);
    },

    async createAssociation(
      input: CreateAssociationInput,
      signal?: AbortSignal,
    ): Promise<AssociationChangeResult> {
      const payload = await request(applicationRoutes.associations, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readAssociationChangeResult(payload);
    },

    async changeAssociation(
      input: ChangeAssociationInput,
      signal?: AbortSignal,
    ): Promise<AssociationChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.associationChanges, {
          associationId: input.associationId,
        }),
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            targetLevel: input.targetLevel,
            targetId: input.targetId,
            quantity: input.quantity ?? null,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readAssociationChangeResult(payload);
    },

    async removeAssociation(
      input: RemoveAssociationInput,
      signal?: AbortSignal,
    ): Promise<AssociationRemovalResult> {
      const payload = await request(
        applicationPath(applicationRoutes.associationRemoval, {
          associationId: input.associationId,
        }),
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: input.expectedRevision }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readAssociationRemovalResult(payload);
    },

    async setCopyLocation(
      input: SetCopyLocationInput,
      signal?: AbortSignal,
    ): Promise<CopyLocationResult> {
      const payload = await request(
        applicationPath(applicationRoutes.copyLocation, { copyId: input.copyId }),
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            locationTagId: input.locationTagId,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readCopyLocationResult(payload);
    },

    async listImportSessions(
      options: ListImportSessionsOptions = {},
      signal?: AbortSignal,
    ): Promise<ImportSessionListResult> {
      const path = withQuery(applicationRoutes.imports, {
        pageSize: options.pageSize,
        continuation: options.continuation,
      });
      return readImportSessionListResult(
        await request(path, signal === undefined ? {} : { signal }),
      );
    },

    async listImportEntries(
      input: ListImportEntriesOptions,
      signal?: AbortSignal,
    ): Promise<ImportEntryListResult> {
      const path = withQuery(
        applicationPath(applicationRoutes.importEntries, { sessionId: input.sessionId }),
        { pageSize: input.pageSize, continuation: input.continuation },
      );
      return readImportEntryListResult(await request(path, signal === undefined ? {} : { signal }));
    },

    async stageImportEntries(
      input: StageImportEntriesInput,
      signal?: AbortSignal,
    ): Promise<ImportStageResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importEntries, { sessionId: input.sessionId }),
        {
          method: 'POST',
          // The session identity is the route; the lines and their source stay the body.
          body: JSON.stringify({ source: input.source, entries: input.entries }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportStageResult(payload);
    },

    async stageSourceImport(
      input: StageSourceImportInput,
      signal?: AbortSignal,
    ): Promise<SourceImportResult> {
      const payload = await request(applicationRoutes.importSources, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readSourceImportResult(payload);
    },

    async stageCaptureObservation(
      input: StageCaptureInput,
      signal?: AbortSignal,
    ): Promise<CaptureStageResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importCaptures, { sessionId: input.sessionId }),
        {
          method: 'POST',
          // The session identity is the route; the observation and its alternatives stay the body.
          body: JSON.stringify({
            captureId: input.captureId,
            printingId: input.printingId ?? null,
            finish: input.finish ?? null,
            candidates: input.candidates ?? [],
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readCaptureStageResult(payload);
    },

    async reviewImportEntry(
      input: ReviewImportEntryInput,
      signal?: AbortSignal,
    ): Promise<ImportEntryChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importEntryReview, { entryId: input.entryId }),
        {
          method: 'POST',
          body: JSON.stringify({
            expectedRevision: input.expectedRevision,
            printingId: input.printingId,
            finish: input.finish,
            condition: input.condition,
            quantity: input.quantity,
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportEntryChangeResult(payload);
    },

    async attachImportCandidates(
      input: AttachImportCandidatesInput,
      signal?: AbortSignal,
    ): Promise<ImportEntryChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importEntryCandidates, { entryId: input.entryId }),
        {
          method: 'POST',
          body: JSON.stringify({ candidates: input.candidates }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportEntryChangeResult(payload);
    },

    async discardImportEntry(
      input: DiscardImportEntryInput,
      signal?: AbortSignal,
    ): Promise<ImportEntryChangeResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importEntryDiscard, { entryId: input.entryId }),
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: input.expectedRevision }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportEntryChangeResult(payload);
    },

    async discardImportSession(
      input: DiscardImportSessionInput,
      signal?: AbortSignal,
    ): Promise<ImportSessionChange> {
      const payload = await request(
        applicationPath(applicationRoutes.importDiscard, { sessionId: input.sessionId }),
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: input.expectedRevision }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportSessionChange(payload);
    },

    async confirmImport(
      input: ConfirmImportInput,
      signal?: AbortSignal,
    ): Promise<ImportConfirmationResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importConfirmation, { sessionId: input.sessionId }),
        {
          method: 'POST',
          body: JSON.stringify({ operationId: input.operationId, entries: input.entries }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return readImportConfirmationResult(payload);
    },

    async recoverImportOperation(
      operationId: string,
      signal?: AbortSignal,
    ): Promise<ImportOperationRecoveryResult> {
      const payload = await request(
        applicationPath(applicationRoutes.importOperation, { operationId }),
        signal === undefined ? {} : { signal },
      );
      return readImportOperationRecoveryResult(payload);
    },
  };
}

/** Component access and public configuration the UserInterface receives (docs/user-interface.md#interface). */
export interface UserInterfaceCapabilities {
  readonly settings: PublicApplicationSettings;
  /** Verified-account capability of this environment's sign-in. */
  readonly identity: BrowserIdentity;
  /** Authenticated transport to the interactive backend entry point. */
  readonly request: AuthenticatedRequest;
  /** Public Catalog reads: card and printing information of the presented entries. */
  readonly catalog: Catalog;
  /** Combined Catalog and UserCards queries with their ordering and continuation. */
  readonly search: SearchClient;
  /** Private copy reads and corrections of the presented account. */
  readonly userCards: UserCardsClient;
  /** Builds the Recognition contract over the browser's preserved engines. */
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
}

export interface BrowserApplicationOptions {
  /** Raw public settings as the deployment published them; private settings are rejected. */
  readonly settings: unknown;
  /**
   * Sign-in interaction of this environment's UserInterface. Application owns the session behind
   * it: the shell asks this prompt for credentials, and the transport carries the token of the
   * session it establishes.
   */
  readonly prompt: BrowserCredentialPrompt;
  /** Where the sign-in keeps its tokens; defaults to this browsing session. */
  readonly storage?: BrowserSessionStore;
  readonly fetch?: typeof globalThis.fetch;
  /** Current time in milliseconds; tests control refresh without changing the system clock. */
  readonly now?: () => number;
  /** Selects a replacement Recognition implementation; defaults to the preserved engines. */
  readonly createRecognition?: (capabilities: {
    readonly settings: PublicApplicationSettings;
    readonly request: AuthenticatedRequest;
  }) => Recognition<HTMLCanvasElement>;
  /** Builds the UserInterface from the capabilities Application supplies. */
  readonly createUserInterface?: (capabilities: UserInterfaceCapabilities) => unknown;
}

export interface BrowserApplication {
  readonly settings: PublicApplicationSettings;
  /** Verified-account capability Application supplies to the UserInterface. */
  readonly identity: BrowserIdentity;
  /** Authenticated transport to every backend entry point of this environment. */
  readonly request: AuthenticatedRequest;
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
  /** The constructed UserInterface, when the environment supplied its factory. */
  readonly userInterface: unknown;
  /** Ends the session: outstanding responses are rejected and no further call is sent without one. */
  endSession(): void;
}

/**
 * Assembles the browser runtime: the authenticated transports, the Catalog and Search contracts
 * and the Recognition contract over the preserved browser engines, and hands the UserInterface its
 * capabilities and public configuration.
 */
export function createBrowserApplication(options: BrowserApplicationOptions): BrowserApplication {
  const settings = resolvePublicSettings(options?.settings);
  const authentication = createBrowserAuthentication({
    settings,
    prompt: options?.prompt,
    ...(options?.storage === undefined ? {} : { storage: options.storage }),
    ...(options?.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  const api = createAuthenticatedRequest({
    baseUrl: settings.apiBaseUrl,
    token: () => authentication.token(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const compute =
    settings.recognition.computeBaseUrl === null
      ? null
      : createAuthenticatedRequest({
          baseUrl: settings.recognition.computeBaseUrl,
          token: () => authentication.token(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
  const request = createEntryPointRequest(api, compute);
  // Account isolation belongs to Application even when no UserInterface is constructed. A token
  // refresh for the same account keeps its requests valid, including the one awaiting that token.
  let accountId = authentication.identity.current()?.accountId ?? null;
  authentication.identity.subscribe((account) => {
    const nextAccountId = account?.accountId ?? null;
    if (nextAccountId !== accountId) {
      accountId = nextAccountId;
      request.endSession();
    }
  });
  const catalog = createCatalogClient(request);
  const search = createSearchClient(request);
  const userCards = createUserCardsClient(request);
  const createRecognitionContract = () =>
    options.createRecognition !== undefined
      ? options.createRecognition({ settings, request })
      : createRecognition<HTMLCanvasElement>({
          createEnginePipeline: () =>
            createBrowserRecognitionPipeline({
              request,
              cloudEnabled: settings.recognition.cloudEnabled,
            }),
          catalog,
          inspectFrame: inspectCanvasFrame,
        });
  const userInterface =
    typeof options.createUserInterface === 'function'
      ? options.createUserInterface({
          settings,
          identity: authentication.identity,
          request,
          catalog,
          search,
          userCards,
          createRecognition: createRecognitionContract,
        })
      : null;
  return {
    settings,
    identity: authentication.identity,
    request,
    createRecognition: createRecognitionContract,
    userInterface,
    endSession() {
      request.endSession();
      void authentication.identity.signOut();
    },
  };
}

/**
 * Routes one preserved request to its entry point: inference goes to the compute runtime, catalog
 * hydration and interactive operations go to the interactive API.
 */
function createEntryPointRequest(
  api: AuthenticatedRequest,
  compute: AuthenticatedRequest | null,
): AuthenticatedRequest {
  const request = (async (path: string, init: AuthenticatedRequestInit = {}) => {
    if (isComputePath(path)) {
      if (compute === null) {
        throw new ApplicationError(
          'unavailable',
          'The recognition compute entry point is not enabled in this environment.',
        );
      }
      return compute(path, init);
    }
    return api(path, init);
  }) as AuthenticatedRequest;
  request.endSession = () => {
    api.endSession();
    compute?.endSession();
  };
  return request;
}

/** True for the preserved inference paths, which the compute runtime serves. */
function isComputePath(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? '';
  return computePaths.includes(withoutQuery);
}

/** Reads the bounded facts of one captured browser frame before any inference starts. */
export function inspectCanvasFrame(frame: HTMLCanvasElement): RecognitionFrameFacts | null {
  if (typeof frame !== 'object' || frame === null) {
    return null;
  }
  const width = frame.width;
  const height = frame.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return null;
  }
  // The preserved browser engines encode a capture as JPEG and learn the encoded size while
  // encoding, so the inspector reports no encoded size.
  return { width, height, format: 'jpeg', encodedBytes: null };
}

async function readCredential(
  token: () => string | null | Promise<string | null>,
): Promise<string> {
  let credential: string | null;
  try {
    credential = await token();
  } catch (cause) {
    throw new ApplicationError('unavailable', 'The sign-in service could not be reached.', {
      cause,
    });
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new ApplicationError('unauthorized', 'Sign in to use the collection.');
  }
  return credential;
}

/**
 * Reads one response body. A withdrawn invocation keeps reporting cancellation while the body is
 * consumed; only a response that fails without a cancellation is an outage.
 */
async function readPayload(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isAborted(signal)) {
      throw new ApplicationError('cancelled', 'The invocation was cancelled.', { cause });
    }
    throw new ApplicationError('unavailable', 'The service returned an unreadable response.', {
      cause,
    });
  }
}

/**
 * The failure one non-ok response reports. Application's own envelope carries the failure code and
 * message; the preserved compute runtime reports a plain message beside its HTTP status, which the
 * status maps into the same failure vocabulary.
 */
function readFailure(status: number, payload: unknown): ApplicationError {
  const envelope = readObject(payload);
  const error = readObject(envelope?.error);
  const code = error?.code;
  const message = error?.message;
  if (isApplicationFailureCode(code) && typeof message === 'string' && message.length > 0) {
    return new ApplicationError(code, message);
  }
  const providerMessage = typeof envelope?.error === 'string' ? envelope.error.trim() : '';
  return new ApplicationError(
    failureCodeForStatus(status),
    providerMessage === '' ? 'The service rejected the request.' : providerMessage,
  );
}

/** The failure one provider status reports when its body carries no Application failure code. */
function failureCodeForStatus(status: number): ApplicationFailureCode {
  switch (status) {
    case 400:
      return 'invalid-request';
    case 401:
    case 403:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 405:
      return 'method-not-allowed';
    case 409:
      return 'conflict';
    case 429:
      return 'busy';
    default:
      return status >= 500 ? 'unavailable' : 'invalid-request';
  }
}

function readCatalogResolution(payload: unknown): CatalogResolution {
  const record = readObject(payload);
  const cards = readRecords(record?.cards, 'cardId');
  const printings = readRecords(record?.printings, 'printingId');
  const revision = readObject(record?.revision);
  if (
    record === null ||
    cards === null ||
    printings === null ||
    revision === null ||
    !Array.isArray(record.missing)
  ) {
    throw unreadableCatalog();
  }
  return {
    revision: revision as unknown as CatalogRevision,
    cards: new Map(cards.map((card) => [String(card.cardId), card as unknown as CardRecord])),
    printings: new Map(
      printings.map((printing) => [
        String(printing.printingId),
        printing as unknown as PrintingRecord,
      ]),
    ),
    missing: record.missing as readonly CatalogReference[],
  };
}

function readPrintingsPage(cardId: string, payload: unknown): CardPrintingsPage {
  const record = readObject(payload);
  const printings = readRecords(record?.printings, 'printingId');
  const revision = readObject(record?.revision);
  const continuation = record?.continuation;
  if (
    record === null ||
    printings === null ||
    revision === null ||
    typeof record.cardExists !== 'boolean' ||
    (continuation !== null && typeof continuation !== 'string')
  ) {
    throw unreadableCatalog();
  }
  return {
    cardId,
    cardExists: record.cardExists,
    revision: revision as unknown as CatalogRevision,
    printings: printings as unknown as readonly PrintingRecord[],
    continuation,
  };
}

function unreadableCatalog(): ApplicationError {
  return new ApplicationError('unavailable', 'The catalog response could not be read.');
}

/**
 * Reads one search page. A response outside the declared shape is an unavailable evaluation
 * rather than an empty page or a different outcome (docs/search.md#request-and-result).
 */
function readSearchPage(payload: unknown): SearchPage {
  const record = readObject(payload);
  const entries = record?.entries;
  if (record === null || !Array.isArray(entries)) {
    throw unreadableSearch();
  }
  const read: SearchEntry[] = [];
  for (const candidate of entries) {
    const entry = readSearchEntry(candidate);
    if (entry === null) {
      throw unreadableSearch();
    }
    read.push(entry);
  }
  const totalCount = record.totalCount ?? null;
  const continuation = record.continuation ?? null;
  const status = record.status;
  const rawRevisions = record.revisions ?? null;
  let revisions: SearchRevisions | null = null;
  if (rawRevisions !== null) {
    const indexed = readObject(rawRevisions);
    const generation = indexed?.generation ?? null;
    const catalogRevision = indexed?.catalogRevision ?? null;
    const catalogPosition = indexed?.catalogPosition ?? null;
    const privateRevision = indexed?.privateRevision ?? null;
    if (
      indexed === null ||
      !isIdentifier(generation) ||
      !isIdentifier(catalogRevision) ||
      !isIdentifier(catalogPosition) ||
      !isIdentifierOrNull(privateRevision)
    ) {
      throw unreadableSearch();
    }
    revisions = { generation, catalogRevision, catalogPosition, privateRevision };
  }
  if (
    (status !== 'ready' && status !== 'updating') ||
    !isSearchCountOrNull(totalCount) ||
    (continuation !== null && typeof continuation !== 'string')
  ) {
    throw unreadableSearch();
  }
  return {
    status,
    entries: read,
    totalCount,
    continuation,
    revisions,
  };
}

/** One entry of a search page, or null when the response does not carry the declared shape. */
function readSearchEntry(value: unknown): SearchEntry | null {
  const entry = readObject(value);
  const entryKey = entry?.entryKey;
  const target = readSearchTarget(entry?.target);
  const card = readObject(entry?.card);
  const cardId = card?.cardId;
  const name = card?.name;
  const matchedName = card?.matchedName ?? null;
  if (
    entry === null ||
    target === null ||
    !isIdentifier(entryKey) ||
    card === null ||
    !isIdentifier(cardId) ||
    !isIdentifier(name) ||
    (matchedName !== null && typeof matchedName !== 'string')
  ) {
    return null;
  }
  const printing = readSearchPrinting(entry.printing);
  if (printing === null && entry.printing !== null) {
    return null;
  }
  const quantity = readSearchQuantity(entry.quantity);
  if (quantity === null && entry.quantity !== null) {
    return null;
  }
  return {
    entryKey,
    target,
    card: { cardId, name, matchedName: matchedName === null ? null : String(matchedName) },
    printing,
    quantity,
  };
}

/** Typed target of one entry, at the level the query requested. */
function readSearchTarget(value: unknown): SearchEntryTarget | null {
  const target = readObject(value);
  const kind = target?.kind;
  const cardId = target?.cardId;
  const printingId = target?.printingId;
  const copyId = target?.copyId;
  if (kind === 'card' && isIdentifier(cardId)) {
    return { kind, cardId };
  }
  if (kind === 'printing' && isIdentifier(printingId)) {
    return { kind, printingId };
  }
  if (kind === 'copy' && isIdentifier(copyId)) {
    return { kind, copyId };
  }
  return null;
}

/** Printing information of one entry; null at card level. */
function readSearchPrinting(value: unknown): SearchEntry['printing'] {
  if (value === null) {
    return null;
  }
  const printing = readObject(value);
  const printingId = printing?.printingId;
  const edition = printing?.edition;
  const collectorNumber = printing?.collectorNumber;
  const language = printing?.language;
  if (
    printing === null ||
    !isIdentifier(printingId) ||
    !isIdentifier(edition) ||
    !isIdentifier(collectorNumber) ||
    !isIdentifier(language)
  ) {
    return null;
  }
  return { printingId, edition, collectorNumber, language };
}

/** Quantity context of one entry: both counts exact, or null when the query evaluated none. */
function readSearchQuantity(value: unknown): SearchEntry['quantity'] {
  if (value === null) {
    return null;
  }
  const quantity = readObject(value);
  if (quantity === null) {
    return null;
  }
  const copies = quantity.copies;
  const intended = quantity.intended;
  if (!isSearchCountOrNull(copies) || !isSearchCountOrNull(intended)) {
    return null;
  }
  return { copies, intended };
}

function isSearchCountOrNull(value: unknown): value is number | null {
  return value === null || isSearchCount(value);
}

/**
 * Reads one private count result. Every requested reference arrives with exact counts; a response
 * outside the declared shape is unavailable rather than an inferred zero.
 */
function readSearchCountResult(payload: unknown): SearchCountResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const counts = record?.counts;
  if (record === null || !isIdentifier(privateRevision) || !Array.isArray(counts)) {
    throw unreadableSearch();
  }
  const read = new Map<string, SearchCount>();
  for (const candidate of counts) {
    const count = readObject(candidate);
    const key = count?.key;
    const owned = count?.owned;
    const locations = count?.locations;
    const intended = count?.intended;
    if (
      count === null ||
      !isIdentifier(key) ||
      !isSearchCount(owned) ||
      !isSearchCount(locations) ||
      !isSearchCountOrNull(intended)
    ) {
      throw unreadableSearch();
    }
    read.set(key, { owned, locations, intended });
  }
  return { privateRevision, counts: read };
}

function isIdentifierOrNull(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isSearchCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Reads a durable publication position: a positive decimal integer carried as text
 * (docs/user-cards.md#query-surface). A change reported without one is unreadable, never a change
 * whose progress a consumer could skip.
 */
function readPublicationPosition(record: Readonly<Record<string, unknown>> | null): string | null {
  const position = record?.publicationPosition;
  return typeof position === 'string' && /^[1-9][0-9]*$/.test(position) ? position : null;
}

function unreadableSearch(): ApplicationError {
  return new ApplicationError('unavailable', 'The search response could not be read.');
}

/** Reads one private copy read. A response outside the declared shape is unavailable, never an
 * empty result that would present an account's copies as absent. */
function readCopyReadResult(payload: unknown): CopyReadResult {
  const record = readObject(payload);
  const copies = readCopyRecords(record?.copies);
  const missing = readIdentifiers(record?.missing);
  const privateRevision = record?.privateRevision;
  if (record === null || copies === null || missing === null || !isIdentifier(privateRevision)) {
    throw unreadableCopies();
  }
  return {
    privateRevision,
    copies: new Map(copies.map((copy) => [copy.copyId, copy] as const)),
    missing,
  };
}

/**
 * Reads one copy change: the committed copies, the private revision the change published and the
 * publication position a consumer resumes from.
 */
function readCopyChangeResult(payload: unknown): CopyChangeResult {
  const record = readObject(payload);
  const copies = readCopyRecords(record?.copies);
  const privateRevision = record?.privateRevision;
  const publicationPosition = readPublicationPosition(record);
  if (
    record === null ||
    copies === null ||
    !isIdentifier(privateRevision) ||
    publicationPosition === null
  ) {
    throw unreadableCopies();
  }
  return { privateRevision, publicationPosition, copies };
}

function readCopyRecords(value: unknown): PhysicalCopy[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const copies: PhysicalCopy[] = [];
  for (const candidate of value) {
    const copy = readObject(candidate);
    const copyId = copy?.copyId;
    const printingId = copy?.printingId;
    const finish = copy?.finish;
    const condition = copy?.condition;
    const revision = copy?.revision;
    if (
      copy === null ||
      !isIdentifier(copyId) ||
      !isIdentifier(printingId) ||
      !isIdentifier(finish) ||
      (condition !== null && !isIdentifier(condition)) ||
      !isCopyRevision(revision)
    ) {
      return null;
    }
    copies.push({
      copyId,
      printingId,
      finish: finish as PhysicalCopy['finish'],
      condition: condition as PhysicalCopy['condition'],
      revision,
    });
  }
  return copies;
}

/** Provider record revision of one copy: a positive whole number. */
function isCopyRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function readIdentifiers(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const identifiers: string[] = [];
  for (const candidate of value) {
    if (!isIdentifier(candidate)) {
      return null;
    }
    identifiers.push(candidate);
  }
  return identifiers;
}

function unreadableCopies(): ApplicationError {
  return new ApplicationError('unavailable', 'The collection response could not be read.');
}

/** Reads one tag record. A response outside the declared shape is never presented as a tag. */
function readTag(value: unknown): Tag | null {
  const tag = readObject(value);
  const tagId = tag?.tagId;
  const kind = tag?.kind;
  const label = tag?.label;
  const system = tag?.system;
  const revision = tag?.revision;
  if (
    tag === null ||
    !isIdentifier(tagId) ||
    typeof kind !== 'string' ||
    !isIdentifier(label) ||
    typeof system !== 'boolean' ||
    !isCopyRevision(revision)
  ) {
    return null;
  }
  return {
    tagId,
    kind: kind as Tag['kind'],
    label,
    system,
    revision,
  };
}

function readTagRecords(value: unknown): Tag[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tags: Tag[] = [];
  for (const candidate of value) {
    const tag = readTag(candidate);
    if (tag === null) {
      return null;
    }
    tags.push(tag);
  }
  return tags;
}

/** Reads one private tag read: the authorized tags and the references this account has none for. */
function readTagReadResult(payload: unknown): TagReadResult {
  const record = readObject(payload);
  const tags = readTagRecords(record?.tags);
  const missing = readIdentifiers(record?.missing);
  const privateRevision = record?.privateRevision;
  if (record === null || tags === null || missing === null || !isIdentifier(privateRevision)) {
    throw unreadableTags();
  }
  return {
    privateRevision,
    tags: new Map(tags.map((tag) => [tag.tagId, tag] as const)),
    missing,
  };
}

/** Reads one page of tags; a page without a readable continuation ends nothing on its own. */
function readTagListResult(payload: unknown): TagListResult {
  const record = readObject(payload);
  const tags = readTagRecords(record?.tags);
  const continuation = record?.continuation;
  const privateRevision = record?.privateRevision;
  if (
    record === null ||
    tags === null ||
    !isIdentifier(privateRevision) ||
    (continuation !== null && !isIdentifier(continuation))
  ) {
    throw unreadableTags();
  }
  return { privateRevision, tags, continuation };
}

/** Reads one tag change: the committed tag and the private revision the change published. */
function readTagChangeResult(payload: unknown): TagChangeResult {
  const record = readObject(payload);
  const tag = readTag(record?.tag);
  const privateRevision = record?.privateRevision;
  const publicationPosition = readPublicationPosition(record);
  if (
    record === null ||
    tag === null ||
    !isIdentifier(privateRevision) ||
    publicationPosition === null
  ) {
    throw unreadableTags();
  }
  return { privateRevision, publicationPosition, tag };
}

/** Reads one association record; card and printing targets carry a quantity, copy targets none. */
function readAssociation(value: unknown): Association | null {
  const association = readObject(value);
  const associationId = association?.associationId;
  const tagId = association?.tagId;
  const targetLevel = association?.targetLevel;
  const targetId = association?.targetId;
  const quantity = association?.quantity ?? null;
  const revision = association?.revision;
  if (
    association === null ||
    !isIdentifier(associationId) ||
    !isIdentifier(tagId) ||
    (targetLevel !== 'card' && targetLevel !== 'printing' && targetLevel !== 'copy') ||
    !isIdentifier(targetId) ||
    (quantity !== null && !isSearchCount(quantity)) ||
    !isCopyRevision(revision)
  ) {
    return null;
  }
  return { associationId, tagId, targetLevel, targetId, quantity, revision };
}

function readAssociationRecords(value: unknown): Association[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const associations: Association[] = [];
  for (const candidate of value) {
    const association = readAssociation(candidate);
    if (association === null) {
      return null;
    }
    associations.push(association);
  }
  return associations;
}

/** Reads one page of one tag's associations with the identity and revision an edit quotes. */
function readAssociationListResult(payload: unknown): AssociationListResult {
  const record = readObject(payload);
  const associations = readAssociationRecords(record?.associations);
  const continuation = record?.continuation;
  const privateRevision = record?.privateRevision;
  if (
    record === null ||
    associations === null ||
    !isIdentifier(privateRevision) ||
    (continuation !== null && !isIdentifier(continuation))
  ) {
    throw unreadableAssociations();
  }
  return { privateRevision, associations, continuation };
}

/** Reads one private association read: authorized associations and the references that were absent. */
function readAssociationReadResult(payload: unknown): AssociationReadResult {
  const record = readObject(payload);
  const associations = readAssociationRecords(record?.associations);
  const missing = readIdentifiers(record?.missing);
  const privateRevision = record?.privateRevision;
  if (
    record === null ||
    associations === null ||
    missing === null ||
    !isIdentifier(privateRevision)
  ) {
    throw unreadableAssociations();
  }
  return {
    privateRevision,
    associations: new Map(
      associations.map((association) => [association.associationId, association] as const),
    ),
    missing,
  };
}

/** Reads one association change: the committed association and the published private revision. */
function readAssociationChangeResult(payload: unknown): AssociationChangeResult {
  const record = readObject(payload);
  const association = readAssociation(record?.association);
  const privateRevision = record?.privateRevision;
  const publicationPosition = readPublicationPosition(record);
  if (
    record === null ||
    association === null ||
    !isIdentifier(privateRevision) ||
    publicationPosition === null
  ) {
    throw unreadableAssociations();
  }
  return { privateRevision, publicationPosition, association };
}

/** Reads one association removal: the removed identity and the published private revision. */
function readAssociationRemovalResult(payload: unknown): AssociationRemovalResult {
  const record = readObject(payload);
  const associationId = record?.associationId;
  const privateRevision = record?.privateRevision;
  const publicationPosition = readPublicationPosition(record);
  if (
    record === null ||
    !isIdentifier(associationId) ||
    !isIdentifier(privateRevision) ||
    publicationPosition === null
  ) {
    throw unreadableAssociations();
  }
  return { privateRevision, publicationPosition, associationId };
}

/** Reads the new single location of one copy; an absent location is an explicit null. */
function readCopyLocationResult(payload: unknown): CopyLocationResult {
  const record = readObject(payload);
  const copies = readCopyRecords(record === null ? null : [record.copy]);
  const location = readAssociation(record?.location);
  const privateRevision = record?.privateRevision;
  const publicationPosition = readPublicationPosition(record);
  if (
    record === null ||
    copies === null ||
    copies[0] === undefined ||
    !isIdentifier(privateRevision) ||
    publicationPosition === null ||
    (record.location !== null && location === null)
  ) {
    throw unreadableCopies();
  }
  return { privateRevision, publicationPosition, copy: copies[0], location };
}

function unreadableTags(): ApplicationError {
  return new ApplicationError('unavailable', 'The tag response could not be read.');
}

function unreadableAssociations(): ApplicationError {
  return new ApplicationError('unavailable', 'The association response could not be read.');
}

/**
 * Reads one pending import session. A response outside the declared shape is unavailable rather
 * than an import without pending entries (docs/user-cards.md#import-and-capture-state).
 */
function readImportSession(value: unknown): ImportSession | null {
  const session = readObject(value);
  const sessionId = session?.sessionId;
  const sourceKind = session?.sourceKind;
  const sourceId = session?.sourceId;
  const sourceReference = session?.sourceReference ?? null;
  const state = session?.state;
  const pendingEntries = session?.pendingEntries;
  const confirmedEntries = session?.confirmedEntries;
  const discardedEntries = session?.discardedEntries;
  const revision = session?.revision;
  if (
    session === null ||
    !isIdentifier(sessionId) ||
    !isIdentifier(sourceKind) ||
    !isIdentifier(sourceId) ||
    (sourceReference !== null && !isIdentifier(sourceReference)) ||
    !isImportState(state) ||
    !isSearchCount(pendingEntries) ||
    !isSearchCount(confirmedEntries) ||
    !isSearchCount(discardedEntries) ||
    !isCopyRevision(revision)
  ) {
    return null;
  }
  return {
    sessionId,
    sourceKind,
    sourceId,
    sourceReference,
    state,
    pendingEntries,
    confirmedEntries,
    discardedEntries,
    revision,
  };
}

/** One stored recognition alternative; a value outside the declared shape is not a candidate. */
function readImportCandidate(value: unknown): ImportCandidate | null {
  const candidate = readObject(value);
  const printingId = candidate?.printingId;
  const provider = candidate?.provider;
  const evidence = candidate?.evidence;
  if (
    candidate === null ||
    !isIdentifier(printingId) ||
    !isIdentifier(provider) ||
    !isIdentifier(evidence)
  ) {
    return null;
  }
  return { printingId, provider, evidence };
}

/** The parsed source line of one pending entry, or null when it carries none. */
function readImportSourceLine(value: unknown): ImportSourceLine | null {
  if (value === null || value === undefined) {
    return null;
  }
  const line = readObject(value);
  const name = line?.name ?? null;
  const section = line?.section ?? null;
  const set = line?.set ?? null;
  const collectorNumber = line?.collectorNumber ?? null;
  const language = line?.language ?? null;
  const finish = line?.finish ?? null;
  const declaredQuantity = line?.declaredQuantity;
  const problem = line?.problem ?? null;
  if (
    line === null ||
    !isTextOrNull(name) ||
    !isTextOrNull(section) ||
    !isTextOrNull(set) ||
    !isTextOrNull(collectorNumber) ||
    !isTextOrNull(language) ||
    (finish !== null && !isIdentifier(finish)) ||
    !isSearchCount(declaredQuantity) ||
    !isTextOrNull(problem)
  ) {
    return null;
  }
  return {
    name,
    section,
    set,
    collectorNumber,
    language,
    finish: finish as ImportSourceLine['finish'],
    declaredQuantity,
    problem,
  };
}

/**
 * Reads one pending entry; a response outside the declared shape is unavailable rather than a
 * pending entry the review could not confirm (docs/user-cards.md#import-and-capture-state).
 */
function readImportEntry(value: unknown): ImportEntry | null {
  const entry = readObject(value);
  const entryId = entry?.entryId;
  const sessionId = entry?.sessionId;
  const position = entry?.position;
  const state = entry?.state;
  const printingId = entry?.printingId ?? null;
  const finish = entry?.finish ?? null;
  const condition = entry?.condition ?? null;
  const quantity = entry?.quantity;
  const candidates = readImportCandidates(entry?.candidates);
  const sourceLine = readImportSourceLine(entry?.sourceLine);
  const revision = entry?.revision;
  if (
    entry === null ||
    !isIdentifier(entryId) ||
    !isIdentifier(sessionId) ||
    !isSearchCount(position) ||
    !isImportState(state) ||
    (printingId !== null && !isIdentifier(printingId)) ||
    (finish !== null && !isIdentifier(finish)) ||
    (condition !== null && !isIdentifier(condition)) ||
    !isSearchCount(quantity) ||
    candidates === null ||
    (entry.sourceLine !== null && sourceLine === null) ||
    !isCopyRevision(revision)
  ) {
    return null;
  }
  return {
    entryId,
    sessionId,
    position,
    state,
    printingId,
    finish: finish as ImportEntry['finish'],
    condition: condition as ImportEntry['condition'],
    quantity,
    candidates,
    sourceLine,
    revision,
  };
}

/** The stored recognition alternatives of one entry; null when the response is unreadable. */
function readImportCandidates(value: unknown): ImportCandidate[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const candidates: ImportCandidate[] = [];
  for (const candidate of value) {
    const read = readImportCandidate(candidate);
    if (read === null) {
      return null;
    }
    candidates.push(read);
  }
  return candidates;
}

function readImportEntryRecords(value: unknown): ImportEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: ImportEntry[] = [];
  for (const candidate of value) {
    const entry = readImportEntry(candidate);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}

/** Reads one page of pending sessions; a page without a readable continuation ends nothing. */
function readImportSessionListResult(payload: unknown): ImportSessionListResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const sessions = record?.sessions;
  const continuation = record?.continuation ?? null;
  const read: ImportSession[] = [];
  let readable = Array.isArray(sessions);
  if (Array.isArray(sessions)) {
    for (const candidate of sessions) {
      const session = readImportSession(candidate);
      if (session === null) {
        readable = false;
        break;
      }
      read.push(session);
    }
  }
  if (
    record === null ||
    !isIdentifier(privateRevision) ||
    !readable ||
    (continuation !== null && !isIdentifier(continuation))
  ) {
    throw unreadableImports();
  }
  return { privateRevision, sessions: read, continuation };
}

/** Reads one page of a session's pending entries with the session the page belongs to. */
function readImportEntryListResult(payload: unknown): ImportEntryListResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const session = readImportSession(record?.session);
  const entries = readImportEntryRecords(record?.entries);
  const continuation = record?.continuation ?? null;
  if (
    record === null ||
    !isIdentifier(privateRevision) ||
    session === null ||
    entries === null ||
    (continuation !== null && !isIdentifier(continuation))
  ) {
    throw unreadableImports();
  }
  return { privateRevision, session, entries, continuation };
}

/** Reads one staging outcome: the staged entries, the session and how many lines were new. */
function readImportStageResult(payload: unknown): ImportStageResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const session = readImportSession(record?.session);
  const entries = readImportEntryRecords(record?.entries);
  const staged = record?.staged;
  const replayed = record?.replayed;
  if (
    record === null ||
    !isIdentifier(privateRevision) ||
    session === null ||
    entries === null ||
    !isSearchCount(staged) ||
    typeof replayed !== 'boolean'
  ) {
    throw unreadableImports();
  }
  return { privateRevision, session, entries, staged, replayed };
}

/** One parsed source row and the reconciliation outcome of its line. */
function readSourceImportRow(value: unknown): SourceImportRow | null {
  const row = readObject(value);
  const position = row?.position;
  const line = row?.line ?? null;
  const outcome = row?.outcome;
  const problem = row?.problem ?? null;
  const entryId = row?.entryId ?? null;
  const sessionId = row?.sessionId ?? null;
  const parsedLine = line === null ? null : readImportSourceLine(line);
  if (
    row === null ||
    !isSearchCount(position) ||
    position < 1 ||
    (line !== null && parsedLine === null) ||
    !isSourceImportOutcome(outcome) ||
    !isTextOrNull(problem) ||
    (entryId !== null && !isIdentifier(entryId)) ||
    (sessionId !== null && !isIdentifier(sessionId)) ||
    // A row the provider could not read carries no parsed line, and every other row carries one.
    (outcome === 'invalid') !== (parsedLine === null)
  ) {
    return null;
  }
  return { position, line: parsedLine, outcome, problem, entryId, sessionId };
}

/** What one parsed source row became. */
function isSourceImportOutcome(value: unknown): value is SourceImportOutcome {
  return value === 'staged' || value === 'pending' || value === 'acquired' || value === 'invalid';
}

/** The reconciliation of one staged source: its session, every row and what this call staged. */
function readSourceImportResult(payload: unknown): SourceImportResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const session = readImportSession(record?.session);
  const rows = readSourceImportRows(record?.rows);
  const staged = record?.staged;
  if (
    record === null ||
    !isIdentifier(privateRevision) ||
    session === null ||
    rows === null ||
    !isSearchCount(staged)
  ) {
    throw unreadableImports();
  }
  return { privateRevision, session, rows, staged };
}

/** The rows one source import reported, in source order. */
function readSourceImportRows(value: unknown): SourceImportRow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows: SourceImportRow[] = [];
  for (const candidate of value) {
    const row = readSourceImportRow(candidate);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}

/** The admission decision of one capture observation. */
function readCaptureStageResult(payload: unknown): CaptureStageResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const outcome = record?.outcome;
  const replayed = record?.replayed;
  const session = readImportSession(record?.session);
  const reported = record?.entry ?? null;
  const entry = reported === null ? null : readImportEntry(reported);
  if (
    record === null ||
    !isIdentifier(privateRevision) ||
    (outcome !== 'admitted' && outcome !== 'suppressed' && outcome !== 'unresolved') ||
    typeof replayed !== 'boolean' ||
    session === null ||
    (reported !== null && entry === null) ||
    (outcome === 'admitted') !== (entry !== null)
  ) {
    throw unreadableImports();
  }
  return { privateRevision, outcome, replayed, session, entry };
}

/** Reads one entry change: the committed entry and the session it stays pending in. */
function readImportEntryChangeResult(payload: unknown): ImportEntryChangeResult {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const session = readImportSession(record?.session);
  const entry = readImportEntry(record?.entry);
  if (record === null || !isIdentifier(privateRevision) || session === null || entry === null) {
    throw unreadableImports();
  }
  return { privateRevision, session, entry };
}

/** Reads one session change: the session a discard or review left behind. */
function readImportSessionChange(payload: unknown): ImportSessionChange {
  const record = readObject(payload);
  const privateRevision = record?.privateRevision;
  const session = readImportSession(record?.session);
  if (record === null || !isIdentifier(privateRevision) || session === null) {
    throw unreadableImports();
  }
  return { privateRevision, session };
}

/**
 * One recorded confirmation: the operation, its acquisition source, the position its copies were
 * published at and the copies it created.
 */
function readImportReceipt(value: unknown): ImportReceipt | null {
  const receipt = readObject(value);
  const operationId = receipt?.operationId;
  const sessionId = receipt?.sessionId;
  const sourceKind = receipt?.sourceKind;
  const sourceId = receipt?.sourceId;
  const publicationPosition = readPublicationPosition(receipt);
  const copies = readCopyRecords(receipt?.copies);
  if (
    receipt === null ||
    !isIdentifier(operationId) ||
    !isIdentifier(sessionId) ||
    !isIdentifier(sourceKind) ||
    !isIdentifier(sourceId) ||
    publicationPosition === null ||
    copies === null
  ) {
    return null;
  }
  return { operationId, sessionId, sourceKind, sourceId, publicationPosition, copies };
}

/** Reads one confirmation: its receipt, whether it replayed a recorded outcome and its revision. */
function readImportConfirmationResult(payload: unknown): ImportConfirmationResult {
  const record = readObject(payload);
  const receipt = readImportReceipt(record);
  const replayed = record?.replayed;
  const privateRevision = record?.privateRevision;
  if (
    record === null ||
    receipt === null ||
    typeof replayed !== 'boolean' ||
    !isIdentifier(privateRevision)
  ) {
    throw unreadableImports();
  }
  return { ...receipt, replayed, privateRevision };
}

/** Reads one operation recovery: the recorded receipt or its explicit absence. */
function readImportOperationRecoveryResult(payload: unknown): ImportOperationRecoveryResult {
  const record = readObject(payload);
  if (record?.outcome === 'absent') {
    return { outcome: 'absent' };
  }
  const receipt = readImportReceipt(record?.receipt);
  if (record?.outcome !== 'recorded' || receipt === null) {
    throw unreadableImports();
  }
  return { outcome: 'recorded', receipt };
}

/** Entry and session lifecycle states of a pending import. */
function isImportState(value: unknown): value is ImportEntryState {
  return value === 'pending' || value === 'confirmed' || value === 'discarded';
}

/** A text field of a parsed source line: a bounded string or an explicit null. */
function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function unreadableImports(): ApplicationError {
  return new ApplicationError('unavailable', 'The import response could not be read.');
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readRecords(
  value: unknown,
  identityKey: string,
): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const records: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    const record = readObject(entry);
    if (record === null || typeof record[identityKey] !== 'string') {
      return null;
    }
    records.push(record);
  }
  return records;
}

function readBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('An authenticated transport requires its base URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError('The authenticated transport requires an absolute base URL.', { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('The authenticated transport requires an http or https base URL.');
  }
  return value;
}

function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function withQuery(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}
