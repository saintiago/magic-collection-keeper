/** Owner continuation failures translated to the list protocol. */
export function readFailureCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export function isInvalidatedContinuation(cause: unknown): boolean {
  const code = readFailureCode(cause);
  return code === 'conflict' || code === 'stale-continuation';
}
