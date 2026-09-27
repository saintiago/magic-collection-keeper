/**
 * Pending imports, review and confirmation (docs/user-cards.md#import-and-capture-state,
 * docs/user-cards.md#persistence-and-recovery).
 *
 * The component owns the active capture session and the persisted pending entries: callers stage an
 * observation or a parsed source line, review what is stored under its revision, and confirm the
 * reviewed entries under an operation identity. Staging and review never change ownership; only a
 * confirmation creates individual copies, with provenance, under a permanent receipt. Recognition
 * supplies candidates, and this contract keeps them beside the reviewed values instead of letting a
 * late alternative advance the accepted sequence or replace the user's corrections.
 */

import { z } from 'zod';

import { finishes, type Catalog, type Finish } from '../../catalog/index.js';
import { physicalFinish, resolvePhysicalPrinting, resolvePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import { candidateTuples, fingerprint, stagedLineFingerprint } from './fingerprint.js';
import {
  USERCARDS_LIMITS,
  copyConditions,
  type CopyCondition,
  type ImportCandidate,
  type ImportEntry,
  type ImportEntryId,
  type ImportOperationId,
  type ImportSession,
  type ImportSessionId,
  type PhysicalCopy,
  type TrustedUserContext,
} from './model.js';
import { decodeContinuation, encodeContinuation } from './pagination.js';
import type { ConfirmedImportEntry, ImportStore, NewStagedImportEntry } from './store.js';

export interface ListImportSessionsOptions {
  readonly pageSize?: number;
  /** Continuation from the previous page of the same account's pending imports. */
  readonly continuation?: string;
}

export interface ListImportEntriesOptions {
  readonly sessionId: ImportSessionId;
  readonly pageSize?: number;
  /** Continuation from the previous page of the same session's pending entries. */
  readonly continuation?: string;
}

export interface ImportSessionListResult {
  readonly privateRevision: string;
  /** Page of pending imports ordered by stable session identity. */
  readonly sessions: readonly ImportSession[];
  /** Continuation for the next page, or null when this page ends the list. */
  readonly continuation: string | null;
}

export interface ImportEntryListResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** Page of the session's pending entries in capture order. */
  readonly entries: readonly ImportEntry[];
  readonly continuation: string | null;
}

/** Identity of the acquisition a staged import belongs to, independent of its editable content. */
export interface ImportSourceInput {
  readonly kind: string;
  readonly id: string;
  /**
   * Official reference of the source, for example an official decklist URL. It is stored with the
   * session when the session is created and never rewritten
   * (docs/user-cards.md#source-imports).
   */
  readonly reference?: string | null;
}

/** One parsed source line about to become a pending entry. */
export interface StageImportEntryInput {
  /** Stable line identity; staging the same identity with identical content is idempotent. */
  readonly entryId: ImportEntryId;
  /** Resolved printing reference, or null while the parsed line is unresolved. */
  readonly printingId?: string | null;
  /** Requested finish, or the printing's first offered finish when it is left open. */
  readonly finish?: Finish | null;
  readonly condition?: CopyCondition | null;
  readonly quantity: number;
  readonly candidates?: readonly ImportCandidate[];
}

export interface StageImportEntriesInput {
  readonly sessionId: ImportSessionId;
  readonly source: ImportSourceInput;
  readonly entries: readonly StageImportEntryInput[];
}

export interface ImportStageResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  /** The staged entries as they are stored now, in capture order. */
  readonly entries: readonly ImportEntry[];
  /** Entries this call staged; the remainder were already staged with identical content. */
  readonly staged: number;
  readonly replayed: boolean;
}

/** One capture observation from Recognition: its validated printing, or null while unresolved. */
export interface StageCaptureInput {
  readonly sessionId: ImportSessionId;
  /** Stable identity of this observation; a retry returns its recorded admission decision. */
  readonly captureId: ImportEntryId;
  readonly printingId?: string | null;
  /** Finish the pending entry starts with; the printing's first offered finish when omitted. */
  readonly finish?: Finish | null;
  readonly candidates?: readonly ImportCandidate[];
}

export interface CaptureStageResult {
  readonly privateRevision: string;
  /** The admission decision: a new entry, a suppressed repeat, or an unresolved reading. */
  readonly outcome: 'admitted' | 'suppressed' | 'unresolved';
  /** Whether this call returned a recorded decision instead of deciding now. */
  readonly replayed: boolean;
  readonly session: ImportSession;
  /** The admitted pending entry; null for a suppressed or unresolved observation. */
  readonly entry: ImportEntry | null;
}

export interface ReviewImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
  readonly printingId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
  readonly quantity: number;
}

export interface ImportEntryChangeResult {
  readonly privateRevision: string;
  readonly session: ImportSession;
  readonly entry: ImportEntry;
}

export interface AttachImportCandidatesInput {
  readonly entryId: ImportEntryId;
  readonly candidates: readonly ImportCandidate[];
}

export interface DiscardImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
}

export interface DiscardImportSessionInput {
  readonly sessionId: ImportSessionId;
  readonly expectedRevision: number;
}

/** One recorded confirmation: the operation, its acquisition source and the copies it created. */
export interface ImportReceipt {
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly copies: readonly PhysicalCopy[];
}

export interface ConfirmImportEntryInput {
  readonly entryId: ImportEntryId;
  readonly expectedRevision: number;
}

export interface ConfirmImportInput {
  /** Operation identity scoped to the account, so a retry refers to the same action. */
  readonly operationId: ImportOperationId;
  readonly sessionId: ImportSessionId;
  readonly entries: readonly ConfirmImportEntryInput[];
}

export interface ImportConfirmationResult extends ImportReceipt {
  /** Whether this call returned the recorded outcome instead of committing the request. */
  readonly replayed: boolean;
  readonly privateRevision: string;
}

export type ImportOperationRecoveryResult =
  | { readonly outcome: 'recorded'; readonly receipt: ImportReceipt }
  | { readonly outcome: 'absent' };

/** The import and capture operations of the UserCards contract. */
export interface ImportOperations {
  listImportSessions(
    context: TrustedUserContext,
    options?: ListImportSessionsOptions,
  ): Promise<ImportSessionListResult>;
  listImportEntries(
    context: TrustedUserContext,
    options: ListImportEntriesOptions,
  ): Promise<ImportEntryListResult>;
  stageImportEntries(
    context: TrustedUserContext,
    input: StageImportEntriesInput,
  ): Promise<ImportStageResult>;
  stageCaptureObservation(
    context: TrustedUserContext,
    input: StageCaptureInput,
  ): Promise<CaptureStageResult>;
  reviewImportEntry(
    context: TrustedUserContext,
    input: ReviewImportEntryInput,
  ): Promise<ImportEntryChangeResult>;
  attachImportCandidates(
    context: TrustedUserContext,
    input: AttachImportCandidatesInput,
  ): Promise<ImportEntryChangeResult>;
  discardImportEntry(
    context: TrustedUserContext,
    input: DiscardImportEntryInput,
  ): Promise<ImportEntryChangeResult>;
  discardImportSession(
    context: TrustedUserContext,
    input: DiscardImportSessionInput,
  ): Promise<ImportSessionChange>;
  confirmImport(
    context: TrustedUserContext,
    input: ConfirmImportInput,
  ): Promise<ImportConfirmationResult>;
  recoverImportOperation(
    context: TrustedUserContext,
    operationId: ImportOperationId,
  ): Promise<ImportOperationRecoveryResult>;
}

export interface ImportSessionChange {
  readonly privateRevision: string;
  readonly session: ImportSession;
}

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;

const referenceSchema = z.string().min(1).max(identifierLength);
const revisionSchema = z.number().int().min(1);
const quantitySchema = z.number().int().min(1).max(USERCARDS_LIMITS.maxCreateQuantity);
const conditionSchema = z.enum(copyConditions).nullable();
const finishSchema = z.enum(finishes);
const candidateSchema = z.object({
  printingId: referenceSchema,
  provider: referenceSchema,
  evidence: referenceSchema,
});
const candidatesSchema = z.array(candidateSchema).max(USERCARDS_LIMITS.maxImportCandidates);
const pageSizeSchema = z
  .number()
  .int()
  .min(USERCARDS_LIMITS.minImportPageSize)
  .max(USERCARDS_LIMITS.maxImportPageSize);

const listSessionsOptionsSchema = z.object({
  pageSize: pageSizeSchema.optional(),
  continuation: referenceSchema.optional(),
});

const listEntriesOptionsSchema = z.object({
  sessionId: referenceSchema,
  pageSize: pageSizeSchema.optional(),
  continuation: referenceSchema.optional(),
});

const stageEntriesRequestSchema = z.object({
  sessionId: referenceSchema,
  source: z.object({
    kind: referenceSchema,
    id: referenceSchema,
    reference: z
      .string()
      .min(1)
      .max(USERCARDS_LIMITS.maxSourceReferenceLength)
      .nullable()
      .optional(),
  }),
  entries: z
    .array(
      z.object({
        entryId: referenceSchema,
        printingId: referenceSchema.nullable().optional(),
        finish: finishSchema.nullable().optional(),
        condition: conditionSchema.optional(),
        quantity: quantitySchema,
        candidates: candidatesSchema.optional(),
      }),
    )
    .min(1)
    .max(USERCARDS_LIMITS.maxStageEntries),
});

const stageCaptureRequestSchema = z.object({
  sessionId: referenceSchema,
  captureId: referenceSchema,
  printingId: referenceSchema.nullable().optional(),
  finish: finishSchema.nullable().optional(),
  candidates: candidatesSchema.optional(),
});

const reviewEntryRequestSchema = z.object({
  entryId: referenceSchema,
  expectedRevision: revisionSchema,
  printingId: referenceSchema,
  finish: finishSchema,
  condition: conditionSchema,
  quantity: quantitySchema,
});

const attachCandidatesRequestSchema = z.object({
  entryId: referenceSchema,
  candidates: candidatesSchema.min(1),
});

const discardEntryRequestSchema = z.object({
  entryId: referenceSchema,
  expectedRevision: revisionSchema,
});

const discardSessionRequestSchema = z.object({
  sessionId: referenceSchema,
  expectedRevision: revisionSchema,
});

const confirmImportRequestSchema = z.object({
  operationId: referenceSchema,
  sessionId: referenceSchema,
  entries: z
    .array(z.object({ entryId: referenceSchema, expectedRevision: revisionSchema }))
    .min(1)
    .max(USERCARDS_LIMITS.maxConfirmEntries),
});

function distinctCandidates(candidates: readonly ImportCandidate[]): ImportCandidate[] {
  const seen = new Set<string>();
  const distinct: ImportCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.printingId}\u0000${candidate.provider}\u0000${candidate.evidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(candidate);
    }
  }
  return distinct;
}

export interface ImportServiceDependencies {
  readonly store: ImportStore;
  readonly catalog: Catalog;
}

/** Private reads and changes of this account's pending imports, review and confirmation. */
export function createImportOperations(dependencies: ImportServiceDependencies): ImportOperations {
  const { store, catalog } = dependencies;

  /**
   * Trims one read to its page size and returns the continuation that follows it. A continuation
   * read at an older private revision is refused instead of skipping or repeating records
   * (docs/user-cards.md#interface).
   */
  function paginate<T>(
    privateRevision: string,
    records: readonly T[],
    offset: number,
    pageSize: number,
    continuation: { readonly revision: string } | null,
  ): { readonly records: readonly T[]; readonly continuation: string | null } {
    if (continuation !== null && continuation.revision !== privateRevision) {
      throw new UserCardsError(
        'conflict',
        'The private data changed after this page was read; start the pending import again.',
      );
    }
    const hasMore = records.length > pageSize;
    return {
      records: hasMore ? records.slice(0, pageSize) : records,
      continuation: hasMore
        ? encodeContinuation({
            version: 1,
            offset: offset + pageSize,
            revision: privateRevision,
          })
        : null,
    };
  }

  return {
    async listImportSessions(
      context: TrustedUserContext,
      options: ListImportSessionsOptions = {},
    ): Promise<ImportSessionListResult> {
      const accountId = accountIdFrom(context);
      const request = listSessionsOptionsSchema.safeParse(options);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `A pending-import page size from ${USERCARDS_LIMITS.minImportPageSize} to ` +
            `${USERCARDS_LIMITS.maxImportPageSize} is required.`,
        );
      }
      const pageSize = request.data.pageSize ?? USERCARDS_LIMITS.defaultImportPageSize;
      const continuation =
        request.data.continuation === undefined
          ? null
          : decodeContinuation(
              request.data.continuation,
              'This continuation is not readable; start the pending import list again.',
            );
      const data = await store.listSessions(accountId, continuation?.offset ?? 0, pageSize + 1);
      const listed = paginate(
        data.privateRevision,
        data.sessions,
        continuation?.offset ?? 0,
        pageSize,
        continuation,
      );
      return {
        privateRevision: data.privateRevision,
        sessions: listed.records,
        continuation: listed.continuation,
      };
    },

    async listImportEntries(
      context: TrustedUserContext,
      options: ListImportEntriesOptions,
    ): Promise<ImportEntryListResult> {
      const accountId = accountIdFrom(context);
      const request = listEntriesOptionsSchema.safeParse(options);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Reading pending entries needs an import identity and a page size from ' +
            `${USERCARDS_LIMITS.minImportPageSize} to ${USERCARDS_LIMITS.maxImportPageSize}.`,
        );
      }
      const pageSize = request.data.pageSize ?? USERCARDS_LIMITS.defaultImportPageSize;
      const continuation =
        request.data.continuation === undefined
          ? null
          : decodeContinuation(
              request.data.continuation,
              'This continuation is not readable; start the pending entry list again.',
            );
      const data = await store.listEntries(
        accountId,
        request.data.sessionId,
        continuation?.offset ?? 0,
        pageSize + 1,
      );
      if (data === null) {
        throw new UserCardsError('not-found', 'This account has no import with that identity.');
      }
      const listed = paginate(
        data.privateRevision,
        data.entries,
        continuation?.offset ?? 0,
        pageSize,
        continuation,
      );
      return {
        privateRevision: data.privateRevision,
        session: data.session,
        entries: listed.records,
        continuation: listed.continuation,
      };
    },

    async stageImportEntries(
      context: TrustedUserContext,
      input: StageImportEntriesInput,
    ): Promise<ImportStageResult> {
      const accountId = accountIdFrom(context);
      const request = stageEntriesRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `Staging takes 1 to ${USERCARDS_LIMITS.maxStageEntries} lines with their own ` +
            'identity, a quantity and at most ' +
            `${USERCARDS_LIMITS.maxImportCandidates} recognition alternatives each.`,
        );
      }
      const { sessionId, source, entries } = request.data;
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.entryId)) {
          throw new UserCardsError(
            'invalid-request',
            'Each staged line needs its own stable identity.',
          );
        }
        seen.add(entry.entryId);
        if ((entry.printingId ?? null) === null && (entry.candidates?.length ?? 0) > 0) {
          throw new UserCardsError(
            'invalid-request',
            'An unresolved line has no resolved alternatives; review it before attaching any.',
          );
        }
      }

      const printings = await resolvePrintings(
        catalog,
        entries.flatMap((entry) => [
          ...(entry.printingId === null || entry.printingId === undefined
            ? []
            : [entry.printingId]),
          ...(entry.candidates ?? []).map((candidate) => candidate.printingId),
        ]),
      );
      const staged: NewStagedImportEntry[] = entries.map((entry) => {
        const candidates = distinctCandidates(entry.candidates ?? []);
        const printingId = entry.printingId ?? null;
        if (printingId === null) {
          return {
            entryId: entry.entryId,
            printingId: null,
            finish: null,
            condition: entry.condition ?? null,
            quantity: entry.quantity,
            candidates,
            sourceLine: null,
            sourceLineKey: null,
            fingerprint: stagedLineFingerprint({
              printingId: null,
              finish: null,
              condition: entry.condition ?? null,
              quantity: entry.quantity,
              candidates,
            }),
          };
        }
        const printing = printings.get(printingId);
        if (printing === undefined) {
          throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
        }
        const finish = physicalFinish(printing, entry.finish ?? null);
        return {
          entryId: entry.entryId,
          printingId,
          finish,
          condition: entry.condition ?? null,
          quantity: entry.quantity,
          candidates,
          sourceLine: null,
          sourceLineKey: null,
          fingerprint: stagedLineFingerprint({
            printingId,
            finish,
            condition: entry.condition ?? null,
            quantity: entry.quantity,
            candidates,
          }),
        };
      });

      const outcome = await store.stageEntries(accountId, {
        sessionId,
        sourceKind: source.kind,
        sourceId: source.id,
        sourceReference: source.reference ?? null,
        entries: staged,
      });
      if (outcome.outcome === 'line-conflict') {
        throw new UserCardsError(
          'conflict',
          'A line was already staged with different content; reload the import before staging it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entries: outcome.entries,
        staged: outcome.staged,
        replayed: outcome.replayed,
      };
    },

    async stageCaptureObservation(
      context: TrustedUserContext,
      input: StageCaptureInput,
    ): Promise<CaptureStageResult> {
      const accountId = accountIdFrom(context);
      const request = stageCaptureRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Staging a capture needs its session and capture identities, a validated printing ' +
            'or an explicit unresolved reading, and at most ' +
            `${USERCARDS_LIMITS.maxImportCandidates} recognition alternatives.`,
        );
      }
      const { sessionId, captureId, printingId, finish: requestedFinish } = request.data;
      const candidates = distinctCandidates(request.data.candidates ?? []);
      if ((printingId ?? null) === null) {
        if ((requestedFinish ?? null) !== null || candidates.length > 0) {
          throw new UserCardsError(
            'invalid-request',
            'An unresolved reading carries no finish or resolved alternatives.',
          );
        }
      }

      const printings = await resolvePrintings(catalog, [
        ...(printingId === null || printingId === undefined ? [] : [printingId]),
        ...candidates.map((candidate) => candidate.printingId),
      ]);
      let identity: string | null = null;
      let finish: Finish | null = null;
      if (printingId !== null && printingId !== undefined) {
        const printing = printings.get(printingId);
        if (printing === undefined) {
          throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
        }
        identity = printing.cardId;
        finish = physicalFinish(printing, requestedFinish ?? null);
      }
      const outcome = await store.stageCapture(accountId, {
        sessionId,
        captureId,
        fingerprint: fingerprint({
          sessionId,
          printingId: printingId ?? null,
          finish,
          candidates: candidateTuples(candidates),
        }),
        identity,
        entry:
          printingId === null || printingId === undefined || finish === null
            ? null
            : {
                entryId: captureId,
                printingId,
                finish,
                condition: null,
                quantity: 1,
                candidates,
              },
      });
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'This capture was already staged with different content; reload the import.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        outcome: outcome.outcome,
        replayed: outcome.replayed,
        session: outcome.session,
        entry: outcome.entry,
      };
    },

    async reviewImportEntry(
      context: TrustedUserContext,
      input: ReviewImportEntryInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = reviewEntryRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'A review needs an entry identity, the revision it started from, a resolved printing ' +
            'and finish, a condition or an explicit unknown condition, and a quantity from 1 to ' +
            `${USERCARDS_LIMITS.maxCreateQuantity}.`,
        );
      }
      const { entryId, expectedRevision, printingId, finish, condition, quantity } = request.data;
      await resolvePhysicalPrinting(catalog, printingId, finish);
      const outcome = await store.correctEntry(accountId, {
        entryId,
        expectedRevision,
        printingId,
        finish,
        condition,
        quantity,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The pending entry changed after this revision; reload it before reviewing it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },

    async attachImportCandidates(
      context: TrustedUserContext,
      input: AttachImportCandidatesInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = attachCandidatesRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Attaching recognition alternatives needs a pending entry and at least one resolved ' +
            `printing, with at most ${USERCARDS_LIMITS.maxImportCandidates} per entry.`,
        );
      }
      const candidates = distinctCandidates(request.data.candidates);
      await resolvePrintings(
        catalog,
        candidates.map((candidate) => candidate.printingId),
      );
      const outcome = await store.attachCandidates(accountId, {
        entryId: request.data.entryId,
        candidates,
      });
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },

    async discardImportEntry(
      context: TrustedUserContext,
      input: DiscardImportEntryInput,
    ): Promise<ImportEntryChangeResult> {
      const accountId = accountIdFrom(context);
      const request = discardEntryRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Discarding needs an entry identity and the revision it started from.',
        );
      }
      const outcome = await store.discardEntry(
        accountId,
        request.data.entryId,
        request.data.expectedRevision,
      );
      if (outcome.outcome === 'missing') {
        throw new UserCardsError(
          'not-found',
          'This account has no pending entry with that identity.',
        );
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'The pending entry changed after this revision; reload it before discarding it.',
        );
      }
      return {
        privateRevision: outcome.privateRevision,
        session: outcome.session,
        entry: outcome.entry,
      };
    },

    async discardImportSession(
      context: TrustedUserContext,
      input: DiscardImportSessionInput,
    ): Promise<ImportSessionChange> {
      const accountId = accountIdFrom(context);
      const request = discardSessionRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          'Discarding an import needs its identity and the revision it started from.',
        );
      }
      const outcome = await store.discardSession(
        accountId,
        request.data.sessionId,
        request.data.expectedRevision,
      );
      if (outcome.outcome === 'missing') {
        throw new UserCardsError('not-found', 'This account has no import with that identity.');
      }
      if (outcome.outcome === 'conflict') {
        throw new UserCardsError(
          'conflict',
          'This import changed after the revision you read; reload it before discarding it.',
        );
      }
      return { privateRevision: outcome.privateRevision, session: outcome.session };
    },

    async confirmImport(
      context: TrustedUserContext,
      input: ConfirmImportInput,
    ): Promise<ImportConfirmationResult> {
      const accountId = accountIdFrom(context);
      const request = confirmImportRequestSchema.safeParse(input);
      if (!request.success) {
        throw new UserCardsError(
          'invalid-request',
          `A confirmation needs an operation identity, an import identity and 1 to ` +
            `${USERCARDS_LIMITS.maxConfirmEntries} reviewed entries with their revisions.`,
        );
      }
      const { operationId, sessionId, entries } = request.data;
      if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) {
        throw new UserCardsError('invalid-request', 'Each confirmed entry needs its own identity.');
      }

      const stored = await store.readEntries(
        accountId,
        entries.map((entry) => entry.entryId),
      );
      const byId = new Map(stored.map((entry) => [entry.entryId, entry] as const));
      const verified = entries.map((requested) => {
        const entry = byId.get(requested.entryId);
        if (entry === undefined || entry.sessionId !== sessionId) {
          throw new UserCardsError(
            'not-found',
            'This account has no pending entry with that identity.',
          );
        }
        return { requested, entry };
      });

      const printings = await resolvePrintings(
        catalog,
        verified.flatMap(({ entry }) =>
          entry.state === 'pending' && entry.printingId !== null ? [entry.printingId] : [],
        ),
      );
      const reviewed: ConfirmedImportEntry[] = verified.map(({ requested, entry }) => {
        let finish = entry.finish;
        if (entry.state === 'pending' && entry.printingId !== null && entry.finish !== null) {
          const printing = printings.get(entry.printingId);
          if (printing === undefined) {
            throw new UserCardsError('not-found', 'The printing is not available in the catalog.');
          }
          finish = physicalFinish(printing, entry.finish);
        }
        const copy = {
          printingId: entry.printingId,
          finish,
          condition: entry.condition,
          quantity: entry.quantity,
        };
        return {
          entryId: entry.entryId,
          expectedRevision: requested.expectedRevision,
          state: entry.state,
          // The reviewed content of this entry is the durable key its acquisition is recorded
          // under, so replay protection does not depend on how a caller partitions confirmations.
          entryFingerprint: fingerprint([
            copy.printingId,
            copy.finish,
            copy.condition,
            copy.quantity,
          ]),
          copy,
        };
      });

      const outcome = await store.confirm(accountId, {
        operationId,
        sessionId,
        inputFingerprint: fingerprint({
          sessionId,
          entries: entries
            .map((entry) => [entry.entryId, entry.expectedRevision] as const)
            .sort((left, right) => left[0].localeCompare(right[0])),
        }),
        entries: reviewed,
      });
      switch (outcome.outcome) {
        case 'missing-session':
          throw new UserCardsError('not-found', 'This account has no import with that identity.');
        case 'missing-entry':
        case 'stale-entry':
          throw new UserCardsError(
            'conflict',
            'A reviewed entry changed or is no longer pending; reload the import before confirming.',
          );
        case 'unresolved-entry':
          throw new UserCardsError(
            'invalid-request',
            'Every confirmed entry needs a reviewed printing and finish first.',
          );
        case 'operation-conflict':
          throw new UserCardsError(
            'conflict',
            'This operation was already used with different input.',
          );
        default:
          return {
            ...outcome.receipt,
            replayed: outcome.replayed,
            privateRevision: outcome.privateRevision,
          };
      }
    },

    async recoverImportOperation(
      context: TrustedUserContext,
      operationId: ImportOperationId,
    ): Promise<ImportOperationRecoveryResult> {
      const accountId = accountIdFrom(context);
      const parsed = referenceSchema.safeParse(operationId);
      if (!parsed.success) {
        throw new UserCardsError('invalid-request', 'An operation identity is required.');
      }
      const receipt = await store.recover(accountId, parsed.data);
      return receipt === null ? { outcome: 'absent' } : { outcome: 'recorded', receipt };
    },
  };
}
