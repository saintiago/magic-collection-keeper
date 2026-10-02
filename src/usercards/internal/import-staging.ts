import { z } from 'zod';
import { type Finish } from '../../catalog/contract.js';
import { pendingFinish, resolvePrintings } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import { candidateTuples, fingerprint, stagedLineFingerprint } from './fingerprint.js';
import type {
  CaptureStageResult,
  ImportOperations,
  ImportServiceDependencies,
  ImportStageResult,
  StageCaptureInput,
  StageImportEntriesInput,
} from './import-contract.js';
import {
  candidatesSchema,
  conditionSchema,
  distinctCandidates,
  finishSchema,
  quantitySchema,
  referenceSchema,
} from './import-validation.js';
import { USERCARDS_LIMITS, type TrustedUserContext } from './model.js';
import type { NewStagedImportEntry } from './store.js';

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

export function createImportStaging(
  dependencies: ImportServiceDependencies,
): Pick<ImportOperations, 'stageImportEntries' | 'stageCaptureObservation'> {
  const { store, catalog } = dependencies;
  return {
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
            cardId: null,
            printingId: null,
            finish: null,
            condition: entry.condition ?? null,
            quantity: entry.quantity,
            candidates,
            sourceLine: null,
            sourceLineKey: null,
            fingerprint: stagedLineFingerprint({
              cardId: null,
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
        const finish = pendingFinish(printing, entry.finish ?? null);
        return {
          entryId: entry.entryId,
          cardId: printing.cardId,
          printingId,
          finish,
          condition: entry.condition ?? null,
          quantity: entry.quantity,
          candidates,
          sourceLine: null,
          sourceLineKey: null,
          fingerprint: stagedLineFingerprint({
            cardId: printing.cardId,
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
        finish = pendingFinish(printing, requestedFinish ?? null);
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
          printingId === null || printingId === undefined
            ? null
            : {
                entryId: captureId,
                cardId: identity,
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
  };
}
