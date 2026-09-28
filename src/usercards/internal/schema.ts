/**
 * UserCards' own published read relations (docs/user-cards.md#query-surface).
 *
 * Private tables live in `usercards_private`. The component's publication reads these views; its
 * reader and trusted publication grants reach nothing else, and another component builds its own
 * searchable data from the publication contract instead of reading them. Both published relations
 * are account-scoped at the database boundary: they select the account bound to the connection with
 * `USERCARDS_ACCOUNT_SCOPE_SQL` and return no rows when no account is bound, so a missing or cleared
 * context fails closed and one account's scope cannot leak into another transaction on a reused
 * connection. Every private view is a security-barrier view, so a consumer's own predicate is
 * evaluated after the account filter instead of on foreign rows.
 * `tests/integration/usercards-query-surface.test.ts` verifies the views against this declaration,
 * so a replacement storage maps its data to exactly these relations and passes the same tests; the
 * publication stream writes the record of a change from the same relations, so a change carries
 * exactly the published record. Pending import state has no published relation: it is read through
 * the component's own pending reads and stays outside the ownership relations
 * (docs/user-cards.md#import-and-capture-state).
 */

import { finishes } from '../../catalog/index.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  copyConditions,
  importEntryStates,
  tagKinds,
} from './model.js';

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
export type UserCardsColumnType = 'text' | 'boolean' | 'integer';

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
    readonly tags: UserCardsQueryRelation;
    readonly associations: UserCardsQueryRelation;
    readonly privateRevision: UserCardsQueryRelation;
  };
}

export const USERCARDS_QUERY_SURFACE: UserCardsQuerySurface = {
  version: 2,
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
        {
          name: 'owned',
          type: 'boolean',
          nullable: false,
          meaning:
            'Whether the copy carries the account’s system owned association; a copy stored by the component is owned until that membership changes.',
        },
        {
          name: 'location_id',
          type: 'text',
          nullable: true,
          meaning:
            'Tag identity of the copy’s single physical location; null while the copy has no location.',
        },
      ],
    },
    tags: {
      name: `${usercardsQuerySchema}.tags`,
      columns: [
        {
          name: 'tag_id',
          type: 'text',
          nullable: false,
          meaning:
            'Tag identity; unique in this relation and stable across label edits and association changes.',
        },
        {
          name: 'kind',
          type: 'text',
          nullable: false,
          meaning: 'Tag kind: deck, wishlist, location, other or the system owned tag.',
        },
        {
          name: 'label',
          type: 'text',
          nullable: false,
          meaning: 'Editable display label; renaming a tag keeps its identity and memberships.',
        },
        {
          name: 'system',
          type: 'boolean',
          nullable: false,
          meaning:
            'Whether the tag is system-managed; its lifecycle is not driven by the tag operations.',
        },
      ],
    },
    associations: {
      name: `${usercardsQuerySchema}.associations`,
      columns: [
        {
          name: 'association_id',
          type: 'text',
          nullable: false,
          meaning: 'Association identity; unique in this relation and stable across refinements.',
        },
        {
          name: 'tag_id',
          type: 'text',
          nullable: false,
          meaning: 'Tag the association belongs to.',
        },
        {
          name: 'target_level',
          type: 'text',
          nullable: false,
          meaning: 'Associated level: card, printing or copy.',
        },
        {
          name: 'target_id',
          type: 'text',
          nullable: false,
          meaning: 'Card, printing or copy identity at the associated level.',
        },
        {
          name: 'quantity',
          type: 'integer',
          nullable: true,
          meaning:
            'Intended or required quantity of a card or printing association; null for copy membership, which is a count of copies.',
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
/** Fingerprints are digests, so their bound only has to cover the encodings a store may choose. */
const fingerprintLength = 128;
const finishValues = finishes.map((finish) => `'${finish}'`).join(', ');
const conditionValues = copyConditions.map((condition) => `'${condition}'`).join(', ');
const tagKindValues = tagKinds.map((kind) => `'${kind}'`).join(', ');
const importEntryStateValues = importEntryStates.map((state) => `'${state}'`).join(', ');
/**
 * Target levels each tag kind may associate, derived from the same declaration the operations
 * enforce, so storage and behaviour cannot drift apart.
 */
const associationLevelsCheckSql = tagKinds
  .map((kind) => {
    const levels = associationLevelsByTagKind[kind].map((level) => `'${level}'`).join(', ');
    return `(tag_kind = '${kind}' and target_level in (${levels}))`;
  })
  .join('\n           or ');

/**
 * The account bound to the connection, or null when none is bound or the setting was cleared.
 * PostgreSQL keeps a custom setting defined with an empty string after a transaction-local value
 * is released, so absence is the setting being unset or blank.
 */
const boundAccountSql = `nullif(current_setting('${USERCARDS_ACCOUNT_SETTING}', true), '')`;

/**
 * Schema owned by the UserCards provider. Applying it is idempotent. The `copies` relation lists
 * the account's physical copies only, together with their derived ownership and location
 * membership; pending import entries have their own records and never appear here. The `tags` and
 * `associations` relations publish the account's organization of cards, printings and copies.
 */
export const usercardsSchemaSql = `
create schema if not exists ${usercardsPrivateSchema};
create schema if not exists ${usercardsQuerySchema};

create table if not exists ${usercardsPrivateSchema}.account_state (
  account_id text primary key check (length(account_id) between 1 and ${identifierLength}),
  revision integer not null default 0 check (revision >= 0),
  -- Lowest publication position still readable for this account. Retention advances it when it
  -- drops older publications, so a resume from before it fails explicitly instead of skipping.
  expired_below bigint not null default 0 check (expired_below >= 0)
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

create table if not exists ${usercardsPrivateSchema}.tag (
  tag_id text primary key check (length(tag_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  kind text not null check (kind in (${tagKindValues})),
  label text not null check (length(label) between 1 and ${identifierLength}),
  system boolean not null default false,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tag_id, kind)
);

create unique index if not exists tag_owned_account_index
  on ${usercardsPrivateSchema}.tag (account_id)
  where kind = 'owned';

create table if not exists ${usercardsPrivateSchema}.association (
  association_id text primary key check (length(association_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  tag_id text not null,
  tag_kind text not null check (tag_kind in (${tagKindValues})),
  target_level text not null check (target_level in ('card', 'printing', 'copy')),
  target_id text not null check (length(target_id) between 1 and ${identifierLength}),
  quantity integer check (quantity is null or quantity >= 1),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tag_id, tag_kind) references ${usercardsPrivateSchema}.tag (tag_id, kind),
  unique (account_id, tag_id, target_level, target_id),
  check ((target_level = 'copy') = (quantity is null)),
  check (${associationLevelsCheckSql})
);

create unique index if not exists association_copy_location_index
  on ${usercardsPrivateSchema}.association (account_id, target_id)
  where target_level = 'copy' and tag_kind = 'location';

create index if not exists association_copy_index
  on ${usercardsPrivateSchema}.association (account_id, target_id)
  where target_level = 'copy';

create index if not exists association_tag_index
  on ${usercardsPrivateSchema}.association (account_id, tag_id);

create table if not exists ${usercardsPrivateSchema}.import_session (
  session_id text not null check (length(session_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  source_kind text not null check (length(source_kind) between 1 and ${identifierLength}),
  source_id text not null check (length(source_id) between 1 and ${identifierLength}),
  source_reference text check (source_reference is null
    or length(source_reference) between 1 and ${USERCARDS_LIMITS.maxSourceReferenceLength}),
  last_accepted_identity text check (last_accepted_identity is null
    or length(last_accepted_identity) between 1 and ${identifierLength}),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, session_id)
);

create table if not exists ${usercardsPrivateSchema}.import_entry (
  entry_id text not null check (length(entry_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  session_id text not null check (length(session_id) between 1 and ${identifierLength}),
  state text not null default 'pending' check (state in (${importEntryStateValues})),
  position integer not null check (position >= 1),
  printing_id text check (printing_id is null or length(printing_id) between 1 and ${identifierLength}),
  finish text check (finish is null or finish in (${finishValues})),
  condition text check (condition in (${conditionValues})),
  quantity integer not null default 1
    check (quantity between 1 and ${USERCARDS_LIMITS.maxCreateQuantity}),
  -- The parsed source line and its durable identity inside the import that staged it. Every field
  -- of the line is separately bounded, so this bound only has to cover the same text after
  -- escaping; the reviewed values stay in the columns above.
  source_line jsonb check (source_line is null or length(source_line::text) <= 16384),
  source_line_key text check (source_line_key is null
    or length(source_line_key) between 1 and 128),
  check ((source_line is null) = (source_line_key is null)),
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, entry_id),
  foreign key (account_id, session_id)
    references ${usercardsPrivateSchema}.import_session (account_id, session_id),
  unique (account_id, session_id, position)
);

create index if not exists import_entry_session_index
  on ${usercardsPrivateSchema}.import_entry (account_id, session_id, position);

-- Entries of one parsed source line are addressed by the line's durable identity inside the import
-- that staged it, so a repeat of that list reconciles its lines without scanning the account's whole
-- pending state.
create index if not exists import_entry_source_line_index
  on ${usercardsPrivateSchema}.import_entry (account_id, session_id, source_line_key)
  where source_line_key is not null;

create table if not exists ${usercardsPrivateSchema}.import_candidate (
  entry_id text not null check (length(entry_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  printing_id text not null check (length(printing_id) between 1 and ${identifierLength}),
  provider text not null check (length(provider) between 1 and ${identifierLength}),
  evidence text not null check (length(evidence) between 1 and ${identifierLength}),
  created_at timestamptz not null default now(),
  primary key (account_id, entry_id, printing_id, provider, evidence),
  foreign key (account_id, entry_id)
    references ${usercardsPrivateSchema}.import_entry (account_id, entry_id)
);

create index if not exists import_candidate_entry_index
  on ${usercardsPrivateSchema}.import_candidate (account_id, entry_id);

create table if not exists ${usercardsPrivateSchema}.import_stage (
  capture_id text not null check (length(capture_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  session_id text not null check (length(session_id) between 1 and ${identifierLength}),
  fingerprint text not null check (length(fingerprint) between 1 and ${fingerprintLength}),
  outcome text not null check (outcome in ('admitted', 'suppressed')),
  entry_id text check (entry_id is null or length(entry_id) between 1 and ${identifierLength}),
  created_at timestamptz not null default now(),
  primary key (account_id, capture_id),
  foreign key (account_id, session_id)
    references ${usercardsPrivateSchema}.import_session (account_id, session_id)
);

-- One acquisition: reviewed content of one source line and its occurrence inside the import that
-- produced it. Its identity is scoped to the account and that import, so a repeat of the list
-- recognizes the recorded outcome instead of acquiring it twice, while another import owns its own
-- acquisitions (docs/user-cards.md#import-state-and-identity). It stays permanent when the reviewed
-- entry is corrected later.
create table if not exists ${usercardsPrivateSchema}.import_acquisition (
  acquisition_id text primary key check (length(acquisition_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  session_id text not null check (length(session_id) between 1 and ${identifierLength}),
  entry_fingerprint text not null check (length(entry_fingerprint) between 1 and ${fingerprintLength}),
  occurrence integer not null check (occurrence >= 1),
  entry_id text not null check (length(entry_id) between 1 and ${identifierLength}),
  committed_at timestamptz not null default now(),
  unique (account_id, session_id, entry_fingerprint, occurrence),
  foreign key (account_id, session_id)
    references ${usercardsPrivateSchema}.import_session (account_id, session_id),
  foreign key (account_id, entry_id)
    references ${usercardsPrivateSchema}.import_entry (account_id, entry_id)
);

-- A confirmed entry keeps its acquisition even when other pending entries are corrected.
create table if not exists ${usercardsPrivateSchema}.import_entry_acquisition (
  account_id text not null,
  entry_id text not null,
  acquisition_id text not null,
  primary key (account_id, entry_id),
  foreign key (account_id, entry_id)
    references ${usercardsPrivateSchema}.import_entry (account_id, entry_id),
  foreign key (acquisition_id)
    references ${usercardsPrivateSchema}.import_acquisition (acquisition_id)
);

create table if not exists ${usercardsPrivateSchema}.import_receipt (
  operation_id text not null check (length(operation_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  session_id text not null check (length(session_id) between 1 and ${identifierLength}),
  input_fingerprint text not null check (length(input_fingerprint) between 1 and ${fingerprintLength}),
  -- Position of the publication that made this outcome's copies visible. A recovered outcome
  -- reports it long after the account published later revisions, so the recorded value stays
  -- permanent with the receipt rather than following the account's current position.
  publication_position bigint check (publication_position is null or publication_position > 0),
  created_at timestamptz not null default now(),
  primary key (account_id, operation_id),
  foreign key (account_id, session_id)
    references ${usercardsPrivateSchema}.import_session (account_id, session_id)
);

create index if not exists import_receipt_input_index
  on ${usercardsPrivateSchema}.import_receipt (account_id, input_fingerprint);

create table if not exists ${usercardsPrivateSchema}.import_receipt_acquisition (
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  operation_id text not null check (length(operation_id) between 1 and ${identifierLength}),
  acquisition_id text not null,
  primary key (account_id, operation_id, acquisition_id),
  foreign key (account_id, operation_id)
    references ${usercardsPrivateSchema}.import_receipt (account_id, operation_id),
  foreign key (acquisition_id)
    references ${usercardsPrivateSchema}.import_acquisition (acquisition_id)
);

create table if not exists ${usercardsPrivateSchema}.copy_provenance (
  copy_id text primary key check (length(copy_id) between 1 and ${identifierLength}),
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  acquisition_id text not null,
  entry_id text not null check (length(entry_id) between 1 and ${identifierLength}),
  printing_id text not null check (length(printing_id) between 1 and ${identifierLength}),
  finish text not null check (finish in (${finishValues})),
  condition text check (condition in (${conditionValues})),
  revision integer not null check (revision >= 1),
  created_at timestamptz not null default now(),
  foreign key (copy_id) references ${usercardsPrivateSchema}.copy (copy_id),
  foreign key (acquisition_id)
    references ${usercardsPrivateSchema}.import_acquisition (acquisition_id),
  foreign key (account_id, entry_id)
    references ${usercardsPrivateSchema}.import_entry (account_id, entry_id)
);

create index if not exists copy_provenance_acquisition_index
  on ${usercardsPrivateSchema}.copy_provenance (account_id, acquisition_id);

-- The durable publication stream (docs/user-cards.md#query-surface). Every query-visible mutation
-- writes the changes of the records it touched and the revision that completes them in its own
-- transaction, so a consumer observes a logical mutation completely or not at all. Positions
-- only grow; the revision names the account-scoped private-data revision the change belongs to,
-- and a record change carries the stable identity and the upsert or removal meaning a consumer
-- applies. Pending import state has no record here.
create table if not exists ${usercardsPrivateSchema}.publication (
  position bigint not null generated always as identity primary key,
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  revision integer not null check (revision >= 1),
  kind text not null check (kind in ('revision', 'copy', 'tag', 'association')),
  record_identity text check (record_identity is null
    or length(record_identity) between 1 and ${identifierLength}),
  removed boolean not null default false,
  record jsonb,
  check (kind <> 'revision' or (record_identity is null and record is null and not removed)),
  check (kind = 'revision' or (record_identity is not null and (removed or record is not null))),
  check (not removed or record is null),
  unique (account_id, revision, kind, record_identity)
);

-- One completion marker per publication; the snapshot reports the newest one's position.
create unique index if not exists publication_revision_index
  on ${usercardsPrivateSchema}.publication (account_id, revision) where kind = 'revision';

create index if not exists publication_account_position_index
  on ${usercardsPrivateSchema}.publication (account_id, position);

create or replace view ${usercardsQuerySchema}.copies with (security_barrier) as
  select copy.copy_id,
         copy.printing_id,
         copy.finish,
         copy.condition,
         (owned.association_id is not null) as owned,
         location.tag_id as location_id
  from ${usercardsPrivateSchema}.copy as copy
  left join ${usercardsPrivateSchema}.association as owned
    on owned.account_id = copy.account_id
   and owned.tag_kind = 'owned'
   and owned.target_level = 'copy'
   and owned.target_id = copy.copy_id
  left join ${usercardsPrivateSchema}.association as location
    on location.account_id = copy.account_id
   and location.tag_kind = 'location'
   and location.target_level = 'copy'
   and location.target_id = copy.copy_id
  where copy.account_id = ${boundAccountSql};

create or replace view ${usercardsQuerySchema}.tags with (security_barrier) as
  select tag_id, kind, label, system
  from ${usercardsPrivateSchema}.tag
  where account_id = ${boundAccountSql};

create or replace view ${usercardsQuerySchema}.associations with (security_barrier) as
  select association_id, tag_id, target_level, target_id, quantity
  from ${usercardsPrivateSchema}.association
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
  assertRole(readerRole);
  const relations = Object.values(USERCARDS_QUERY_SURFACE.relations).map(
    (relation) => relation.name,
  );
  return [
    `grant usage on schema ${usercardsQuerySchema} to "${readerRole}";`,
    `grant select on ${relations.join(', ')} to "${readerRole}";`,
  ].join('\n');
}

/**
 * Grants trusted indexing access to the publication contract: the account-scoped published
 * relations, the durable change stream and the recorded retention floor, and no mutation.
 * Application supplies this credential to an indexing runtime separately from an end-user read
 * role (docs/data-architecture.md#access-and-deployment); an end-user read role never reaches the
 * private schema and an indexer never reaches the private records behind the publication.
 */
export function usercardsPublicationGrants(role: string): string {
  assertRole(role);
  return [
    usercardsReaderGrants(role),
    `grant usage on schema ${usercardsPrivateSchema} to "${role}";`,
    `grant select on ${usercardsPrivateSchema}.publication to "${role}";`,
    `grant select on ${usercardsPrivateSchema}.account_state to "${role}";`,
  ].join('\n');
}

function assertRole(role: string): void {
  if (!readerRolePattern.test(role)) {
    throw new TypeError(
      `UserCards role must be a lowercase PostgreSQL identifier, received "${role}".`,
    );
  }
}
