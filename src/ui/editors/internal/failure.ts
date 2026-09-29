/**
 * Presentation of the UserCards browser operations the UserInterface presents
 * (docs/user-interface.md#browsing-and-organization, docs/user-cards.md#browser-operation-lifecycle).
 *
 * The provider-owned operation handle decides whether a change committed, was rejected or stays
 * unknown; a view never infers that classification from a raw failure and keeps no list of failure
 * codes of its own. Only a committed outcome is presented as saved. A change whose outcome stays
 * unknown recovers through a read of the record, so a lost response is never presented as a saved
 * change while the record's current state stays reviewable.
 */

import type { UserCardsOperation } from '../../../usercards/browser.js';

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
  // An unknown outcome keeps its own presentation: the earlier attempt of the same identity stays
  // unresolved until an authoritative read or the owner resolves it, and the view never decides
  // from a failure code that the operation did not apply.
  return {
    status: 'unknown',
    message:
      record !== null ? 'The outcome is unknown. Review the record before retrying.' : unknown,
    record,
  };
}

/** Message of one rejected operation, or the fallback when the cause carries none. */
export function readUiFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
