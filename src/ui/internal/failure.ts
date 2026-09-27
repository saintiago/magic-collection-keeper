/**
 * Failure classification of the UserInterface's private changes and of the read failures the list
 * sources translate into their presentation contract
 * (docs/user-interface.md#browsing-and-organization,
 * docs/user-interface.md#list-boundary, docs/application.md#construction-and-request-boundary).
 *
 * A rejected change either establishes that the operation did not run — the request was refused
 * before it could commit — or leaves its outcome open because the response was lost, the service
 * was busy or the invocation was withdrawn after dispatch. The views report the first as a
 * definite failure and recover the second through a read of the record, so a lost response is
 * never presented as a saved change. The classification and the resulting outcome live here, so
 * every view that changes a private record presents the same statuses.
 *
 * A rejected bounded read whose continuation bound the provider's revisions reports the same
 * outcome under Catalog's and Search's `stale-continuation` and under UserCards' `conflict`, so the
 * source bindings share one test for it instead of each interpreting those codes on its own.
 */

/** Outcome of one private change as a view presents it. */
export interface UiChangeCommit<Record> {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  /** User-facing explanation, or null when the committed change needs none. */
  readonly message: string | null;
  /** Committed record, or the record a recovery read observed; null when neither is available. */
  readonly record: Record | null;
}

/**
 * One private change: a success reports its committed record; a revision conflict and a definite
 * failure report the operation's own outcome; every other rejection stays unknown and recovers the
 * record for review without inferring the operation's outcome
 * (docs/application.md#construction-and-request-boundary).
 */
export async function commitUiChange<Record>(
  change: () => Promise<Record>,
  recover: () => Promise<Record | null>,
  fallback: string,
  unknown = 'The outcome is unknown. Reload the view before retrying.',
): Promise<UiChangeCommit<Record>> {
  try {
    return { status: 'committed', message: null, record: await change() };
  } catch (cause) {
    const code = readUiFailureCode(cause);
    if (code === 'conflict') {
      return { status: 'conflict', message: readUiFailureMessage(cause, fallback), record: null };
    }
    if (code !== null && isUiDefiniteFailure(code)) {
      return { status: 'failed', message: readUiFailureMessage(cause, fallback), record: null };
    }
    const record = await recover();
    return {
      status: 'unknown',
      message:
        record === null ? unknown : 'The outcome is unknown. Review the record before retrying.',
      record,
    };
  }
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
