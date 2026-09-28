/**
 * UserCards failures that consumers and Application map to transport outcomes. Validation, a
 * missing authorized record, a revision conflict and temporary unavailability stay distinct: a
 * foreign or unknown private reference is a missing record in every case, never a success and
 * never evidence that another account owns it (docs/user-cards.md#interface).
 *
 * A publication continuation or change position the component can no longer resume from reports
 * `stale-continuation`: the account published another revision after a snapshot page, or the
 * position is not one this account's retained publication history carries, whether expired or
 * another account's. Either outcome requires reading a new snapshot rather than skipping changes
 * (docs/user-cards.md#query-surface).
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
