/**
 * UserCards staging binding of the Capture component (docs/capture.md#interface,
 * docs/user-cards.md#browser-operation-lifecycle).
 *
 * The binding translates UserCards' account-scoped operation facade into Capture's staging
 * protocol: one observation stages under its capture identity and a repeat returns the recorded
 * decision, late alternatives attach beside an admitted entry's reviewed values, and an unfinished
 * attempt is presented again through the retained handle that owns its identity and input. The
 * provider-owned handle decides whether a change committed, was rejected or stays unknown; the
 * binding never infers commitment from a raw failure and never composes a second attempt to guess
 * whether one committed.
 */

import type {
  UserCardsAccountOperations,
  UserCardsOperation,
  UserCardsOperationOutcome,
} from '../../usercards/browser.js';
import type { CaptureStageResult } from '../../usercards/index.js';

import type {
  CaptureOperationOutcome,
  CaptureRetainedOperation,
  CaptureRetainedObservation,
  CaptureStaging,
  CaptureStagingOperation,
} from './contract.js';

/** Staging of one account as Capture coordinates it, over the provider-owned operation handles. */
export function captureStaging(userCards: UserCardsAccountOperations): CaptureStaging {
  if (typeof userCards?.stageCaptureObservation !== 'function') {
    throw new TypeError('captureStaging requires the UserCards account operations it presents.');
  }
  return {
    stage(input, signal) {
      return stagingOperation(userCards.stageCaptureObservation(input, signal));
    },
    attach(input, signal) {
      return stagingOperation(userCards.attachImportCandidates(input, signal));
    },
    retained(): readonly CaptureRetainedObservation[] {
      return userCards
        .retained()
        .flatMap((attempt) =>
          attempt.kind === 'stageCaptureObservation'
            ? [{ captureId: attempt.operationId, input: attempt.request }]
            : [],
        );
    },
    resume(captureId, signal) {
      const attempt = userCards.resume(captureId);
      if (attempt === null || attempt.kind !== 'stageCaptureObservation') {
        return null;
      }
      return {
        operationId: captureId,
        input: attempt.request,
        // Recovery replays the identity and input the provider already owns, so a lost response
        // returns the recorded decision instead of staging the observation again. The recovering
        // caller's own scope replaces the departed one: the retained attempt keeps its identity,
        // while the replay is cancelled with the session that dispatches it
        // (docs/user-cards.md#browser-operation-lifecycle).
        observe: async (): Promise<CaptureOperationOutcome<CaptureStageResult>> =>
          readOutcome(await attempt.retry(signal)),
      } satisfies CaptureRetainedOperation<CaptureStageResult>;
    },
  };
}

/** One provider-owned handle as Capture's observable operation. */
function stagingOperation<Kind extends string, Record>(
  operation: UserCardsOperation<Kind, Record>,
): CaptureStagingOperation<Record> {
  return {
    operationId: operation.operationId,
    async observe(): Promise<CaptureOperationOutcome<Record>> {
      return readOutcome(await operation.observe());
    },
  };
}

/** What one provider outcome established: a record, a rejection with its message, or no outcome. */
function readOutcome<Record>(
  outcome: UserCardsOperationOutcome<Record>,
): CaptureOperationOutcome<Record> {
  switch (outcome.state) {
    case 'committed':
      return { state: 'committed', record: outcome.record };
    case 'rejected':
      return {
        state: 'rejected',
        message: outcome.failure.message.length === 0 ? null : outcome.failure.message,
      };
    default:
      // A reattached attempt never reported into this view, so what the provider established stays
      // unknown until its own handle is retried; an observer of a settled attempt resolves here.
      return { state: 'unknown' };
  }
}
