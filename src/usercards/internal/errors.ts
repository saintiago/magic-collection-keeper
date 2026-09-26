/**
 * UserCards failures that consumers and Application map to transport outcomes. Validation, a
 * missing authorized record, a revision conflict and temporary unavailability stay distinct: a
 * foreign or unknown private reference is a missing record in every case, never a success and
 * never evidence that another account owns it (docs/user-cards.md#interface).
 */
export type UserCardsFailureCode = 'invalid-request' | 'not-found' | 'conflict' | 'unavailable';

export class UserCardsError extends Error {
  readonly code: UserCardsFailureCode;

  constructor(code: UserCardsFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserCardsError';
    this.code = code;
  }
}
