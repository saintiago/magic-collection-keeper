/**
 * The published query surface of UserCards (docs/user-cards.md#query-surface).
 *
 * Private tables live in `usercards_private`; consumers read only the views in `usercards`. Both
 * views are account-scoped at the database boundary: they select the account bound to the
 * connection with `USERCARDS_ACCOUNT_SCOPE_SQL` and return no rows when no account is bound, so a
 * missing or cleared context fails closed and one account's scope cannot leak into another
 * transaction on a reused connection. The `copies` view is a security-barrier view, so a
 * consumer's own predicate is evaluated after the account filter instead of on foreign rows.
 * `tests/integration/usercards-query-surface.test.ts` verifies the views against this declaration,
 * so a replacement storage maps its data to exactly these relations and passes the same tests.
 */

import { finishes } from '../../catalog/index.js';
import { USERCARDS_LIMITS, copyConditions } from './model.js';

export const usercardsQuerySchema = 'usercards';
export const usercardsPrivateSchema = 'usercards_private';

/**
 * Connection setting that carries the trusted account while the views are read. It is bound inside
 * the read transaction and is transaction-local, so releasing the connection also releases the
 * scope.
 */
export const USERCARDS_ACCOUNT_SETTING = 'usercards.account_id';

/**
 * Statement Application runs with the verified account inside the transaction that reads the
 * views. Without it the scoped relations return no rows instead of every account's private data.
 */
export const USERCARDS_ACCOUNT_SCOPE_SQL = `select set_config('${USERCARDS_ACCOUNT_SETTING}', :account_id, true)`;

/** Column types as consumers read them, not the storage's internal representation. */
export type UserCardsColumnType = 'text';

export interface UserCardsRelationColumn {
  readonly name: string;
  readonly type: UserCardsColumnType;
  readonly nullable: boolean;
  readonly meaning: string;
}

export interface UserCardsQueryRelation {
  /** Schema-qualified relation name. Private table names never appear here. */
  readonly name: string;
  readonly columns: readonly UserCardsRelationColumn[];
}

export interface UserCardsQuerySurface {
  readonly version: number;
  readonly relations: {
    readonly copies: UserCardsQueryRelation;
    readonly privateRevision: UserCardsQueryRelation;
  };
}

export const USERCARDS_QUERY_SURFACE: UserCardsQuerySurface = {
  version: 1,
  relations: {
    copies: {
      name: `${usercardsQuerySchema}.copies`,
      columns: [
        {
          name: 'copy_id',
          type: 'text',
          nullable: false,
          meaning: 'Physical-copy identity; unique in this relation and stable across corrections.',
        },
        {
          name: 'printing_id',
          type: 'text',
          nullable: false,
          meaning: 'Catalog printing reference; the card, edition and language follow from it.',
        },
        {
          name: 'finish',
          type: 'text',
          nullable: false,
          meaning: 'Physical finish of the copy: nonfoil, foil or etched.',
        },
        {
          name: 'condition',
          type: 'text',
          nullable: true,
          meaning: 'Physical condition code; null while the condition is unknown.',
        },
      ],
    },
    privateRevision: {
      name: `${usercardsQuerySchema}.private_revision`,
      columns: [
        {
          name: 'revision',
          type: 'text',
          nullable: false,
          meaning:
            'Monotonic revision of the bound account’s private data, 0 before the first change; a continuation becomes stale when it changes.',
        },
      ],
    },
  },
};

const identifierLength = USERCARDS_LIMITS.maxIdentifierLength;
const finishValues = finishes.map((finish) => `'${finish}'`).join(', ');
const conditionValues = copyConditions.map((condition) => `'${condition}'`).join(', ');

/**
 * The account bound to the connection, or null when none is bound or the setting was cleared.
 * PostgreSQL keeps a custom setting defined with an empty string after a transaction-local value
 * is released, so absence is the setting being unset or blank.
 */
const boundAccountSql = `nullif(current_setting('${USERCARDS_ACCOUNT_SETTING}', true), '')`;

/**
 * Schema owned by the UserCards provider. Applying it is idempotent. The `copies` relation lists
 * the account's physical copies only; pending import entries have their own records and never
 * appear here.
 */
export const usercardsSchemaSql = `
create schema if not exists ${usercardsPrivateSchema};
create schema if not exists ${usercardsQuerySchema};

create table if not exists ${usercardsPrivateSchema}.account_state (
  account_id text primary key check (length(account_id) between 1 and ${identifierLength}),
  revision integer not null default 0 check (revision >= 0)
);

create table if not exists ${usercardsPrivateSchema}.copy (
  copy_id text primary key check (length(copy_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  printing_id text not null check (length(printing_id) between 1 and ${identifierLength}),
  finish text not null check (finish in (${finishValues})),
  condition text check (condition in (${conditionValues})),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists copy_account_identity_index
  on ${usercardsPrivateSchema}.copy (account_id, copy_id);

create or replace view ${usercardsQuerySchema}.copies with (security_barrier) as
  select copy_id, printing_id, finish, condition
  from ${usercardsPrivateSchema}.copy
  where account_id = ${boundAccountSql};

create or replace view ${usercardsQuerySchema}.private_revision as
  select coalesce(state.revision, 0)::text as revision
  from (select ${boundAccountSql} as account_id) as bound
  left join ${usercardsPrivateSchema}.account_state as state
    on state.account_id = bound.account_id
  where bound.account_id is not null;

revoke all on schema ${usercardsPrivateSchema} from public;
`.trim();

const readerRolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants a consumer role read access to the published views and nothing else. The UserCards schema
 * owner applies this after `usercardsSchemaSql`; base tables stay unreachable for the reader.
 */
export function usercardsReaderGrants(readerRole: string): string {
  if (!readerRolePattern.test(readerRole)) {
    throw new TypeError(
      `UserCards reader role must be a lowercase PostgreSQL identifier, received "${readerRole}".`,
    );
  }
  const relations = Object.values(USERCARDS_QUERY_SURFACE.relations).map(
    (relation) => relation.name,
  );
  return [
    `grant usage on schema ${usercardsQuerySchema} to "${readerRole}";`,
    `grant select on ${relations.join(', ')} to "${readerRole}";`,
  ].join('\n');
}
