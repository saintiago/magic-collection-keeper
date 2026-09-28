/**
 * Presentation of the UserCards browser operations the UserInterface presents and of the read
 * failures the list sources translate into their presentation contract
 * (docs/user-interface.md#browsing-and-organization,
 * docs/user-interface.md#list-boundary, docs/user-cards.md#browser-operation-lifecycle).
 *
 * The provider-owned operation handle decides whether a change committed, was rejected or stays
 * unknown; a view never infers that classification from a raw failure. Only a committed outcome is
 * presented as saved. A change whose outcome stays unknown recovers through a read of the record,
 * so a lost response is never presented as a saved change while the record's current state stays
 * reviewable.
 *
 * A rejected bounded read whose continuation bound the provider's revisions reports the same
 * outcome under Catalog's and Search's `stale-continuation` and under UserCards' `conflict`, so the
 * source bindings share one test for it instead of each interpreting those codes on its own.
 */

import type { UserCardsOperation } from '../../usercards/browser.js';

/** Outcome of one private change as a view presents it. */
export interface UiChangeCommit<Record> {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  /** User-facing explanation, or null when the committed change needs none. */
  readonly message: string | null;
  /** Committed record, or the record a recovery read observed; null when neither is available. */
  readonly record: Record | null;
}

/** One provider-owned change the views present. */
export type UiOperation<Record> = UserCardsOperation<string, Record>;

/**
 * Waits for one begun change and presents what UserCards established: a committed record, a
 * rejection of the operation's own outcome, or an unknown outcome that recovers through the read
 * the caller supplies (docs/application.md#construction-and-request-boundary).
 */
export async function commitUiOperation<Change, Record = Change>(
  operation: UiOperation<Change>,
  recover: () => Promise<Record | null>,
  fallback: string,
  options: {
    /** What an unknown outcome reports when the recovery read observed nothing. */
    readonly unknown?: string;
    /** The value the view presents from the change's own record. */
    readonly record?: (change: Change) => Record;
  } = {},
): Promise<UiChangeCommit<Record>> {
  const unknown = options.unknown ?? 'The outcome is unknown. Reload the view before retrying.';
  const select = options.record ?? ((change: Change) => change as unknown as Record);
  const outcome = await operation.observe();
  if (outcome.state === 'committed') {
    return { status: 'committed', message: null, record: select(outcome.record) };
  }
  if (outcome.state === 'rejected') {
    const message = outcome.failure.message === '' ? fallback : outcome.failure.message;
    return outcome.failure.code === 'conflict'
      ? { status: 'conflict', message, record: null }
      : { status: 'failed', message, record: null };
  }
  // An observer resolves a settled operation, so the only remaining state is an unknown outcome.
  const record = await recover();
  // An unknown outcome that reported a definite refusal of a retry presents that refusal: the
  // earlier attempt of the same identity stays unresolved and the owner decides what to do.
  const failure = outcome.state === 'unknown' ? outcome.failure : null;
  const refusal =
    failure !== null && failure.code !== null && isUiDefiniteFailure(failure.code)
      ? failure.message
      : null;
  return {
    status: 'unknown',
    message:
      record !== null
        ? 'The outcome is unknown. Review the record before retrying.'
        : (refusal ?? unknown),
    record,
  };
}

/**
 * Failure codes that establish the change was not applied: the request was rejected before it
 * could commit, so the view reports a definite failure instead of recovering a recorded outcome.
 * A cancellation, a timeout, a busy service, an unavailable service and every other outcome after
 * dispatch leave the change's commitment open; reading the record cannot resolve that uncertainty.
 */
export function isUiDefiniteFailure(code: string): boolean {
  return (
    code === 'invalid-request' ||
    code === 'unsupported-query' ||
    code === 'not-found' ||
    code === 'unauthorized' ||
    code === 'route-not-found' ||
    code === 'method-not-allowed'
  );
}

/** Failure code of one rejected operation, or null when the cause carries none. */
export function readUiFailureCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) {
    return null;
  }
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * True when a rejected read reported that the revision its continuation named changed: the
 * sequence is invalidated and must restart from its first page rather than repeat the rejected
 * continuation (docs/user-interface.md#list-boundary). Only a source binding asks this, so CardList
 * itself stays independent of provider failure codes.
 */
export function isUiInvalidatedContinuation(cause: unknown): boolean {
  const code = readUiFailureCode(cause);
  return code === 'conflict' || code === 'stale-continuation';
}

/** Message of one rejected operation, or the fallback when the cause carries none. */
export function readUiFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
