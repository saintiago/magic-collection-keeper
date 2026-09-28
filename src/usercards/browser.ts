/**
 * UserCards browser entry point (docs/user-cards.md#browser-operation-lifecycle,
 * docs/application.md#interface).
 *
 * The component owns the browser side of its private operations: the port a transport adapter
 * serves, the operation facade that begins, retains, observes, recovers and retries one user
 * operation under its account-scoped identity, the committed-change invalidations CardList
 * reloads from, and the input constraints and operation availability its consumers present.
 * Application's browser composition supplies the authenticated transport adapter and the browser
 * session's attempt storage; only browser-safe capabilities are published here, so a browser
 * bundle never reaches the component's SQL, publication or job modules. The component's backend
 * contracts stay `src/usercards/index.ts`; other components import UserCards through these public
 * entry points only (docs/architecture.md, .dependency-cruiser.mjs).
 */

export {
  usercardsBrowserOperations,
  usercardsConstraints,
  type UserCardsBrowserOperation,
  type UserCardsConstraints,
  type UserCardsPageBounds,
} from './internal/browser/constraints.js';
export {
  createUserCardsOperations,
  type UserCardsAccountOperations,
  type UserCardsAttemptStorage,
  type UserCardsBrowserClient,
  type UserCardsChange,
  type UserCardsChangeScope,
  type UserCardsConfirmationOutcome,
  type UserCardsConfirmationRequest,
  type UserCardsOperation,
  type UserCardsOperationFailure,
  type UserCardsOperationOutcome,
  type UserCardsOperations,
  type UserCardsOperationsOptions,
  type UserCardsRecordReference,
  type UserCardsRetainedAttempt,
  type UserCardsSourceImportRequest,
} from './internal/browser/operations.js';
