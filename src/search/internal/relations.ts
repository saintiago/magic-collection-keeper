import { SEARCH_ACCOUNT_SETTING, SEARCH_PROJECTION_SURFACE } from './schema.js';

/**
 * Relations of Search's published projection, taken from the declaration instead of repeated text.
 * Evaluation and freshness read the same published relations; a replacement storage maps its data
 * to exactly these (docs/search.md#internal-design).
 */
export const projectionRelations = {
  cards: SEARCH_PROJECTION_SURFACE.relations.cards.name,
  cardNames: SEARCH_PROJECTION_SURFACE.relations.cardNames.name,
  printings: SEARCH_PROJECTION_SURFACE.relations.printings.name,
  copies: SEARCH_PROJECTION_SURFACE.relations.copies.name,
  associations: SEARCH_PROJECTION_SURFACE.relations.associations.name,
  indexState: SEARCH_PROJECTION_SURFACE.relations.indexState.name,
  accountState: SEARCH_PROJECTION_SURFACE.relations.accountState.name,
} as const;

/** Account-scoped indexed publication position of the account bound to a read, or null. */
export const privateRevisionSql = `(select account.position from ${projectionRelations.accountState} as account)`;

/**
 * The account bound to the read transaction, or null when none is bound. A private read verifies
 * it was executed inside the account scope instead of trusting that empty rows mean an empty
 * account (docs/data-architecture.md#access-and-deployment).
 */
export const boundAccountSql = `nullif(current_setting('${SEARCH_ACCOUNT_SETTING}', true), '')`;
