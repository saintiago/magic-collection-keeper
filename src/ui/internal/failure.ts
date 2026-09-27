/**
 * Failure classification of the UserInterface's private changes
 * (docs/user-interface.md#browsing-and-organization,
 * docs/application.md#construction-and-request-boundary).
 *
 * A rejected change either establishes that the operation did not run — the request was refused
 * before it could commit — or leaves its outcome open because the response was lost, the service
 * was busy or the invocation was withdrawn after dispatch. The views report the first as a
 * definite failure and recover the second through a read of the record, so a lost response is
 * never presented as a saved change.
 */

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

/** Message of one rejected operation, or the fallback when the cause carries none. */
export function readUiFailureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
