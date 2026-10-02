/**
 * UserCards failures that consumers and Application map to transport outcomes. Validation, a
 * missing authorized record, a revision conflict and temporary unavailability stay distinct: a
 * foreign or unknown private reference is a missing record in every case, never a success and
 * never evidence that another account owns it (docs/user-cards.md#interface).
 *
 * A continuation invalidated by changed criteria or an authoritative revision reports
 * `stale-continuation`, so a consumer starts again from the first page.
 */
export type UserCardsFailureCode =
  'invalid-request' | 'not-found' | 'conflict' | 'stale-continuation' | 'unavailable';

export class UserCardsError extends Error {
  readonly code: UserCardsFailureCode;

  constructor(code: UserCardsFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserCardsError';
    this.code = code;
  }
}
