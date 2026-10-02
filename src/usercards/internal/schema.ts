/** UserCards-owned storage and account-scoped read views. Every private view enforces the transaction account before exposing records. Query readers receive only the owner query surface; mutations and pending reads remain behind their own contracts. */

import { finishes } from '../../catalog/contract.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  copyConditions,
  importEntryStates,
  tagKinds,
} from './model.js';

export const usercardsPrivateSchema = 'usercards_private';
export const usercardsCurrentQuerySchema = 'usercards_current_query';

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

/** Idempotent authoritative storage and read-only account-scoped query views. */
export const usercardsSchemaSql = `
create schema if not exists ${usercardsPrivateSchema};
create schema if not exists ${usercardsCurrentQuerySchema};

create table if not exists ${usercardsPrivateSchema}.account_state (
  account_id text primary key check (length(account_id) between 1 and ${identifierLength}),
  revision integer not null default 0 check (revision >= 0)
);

-- UserCards keeps the stable playable-card relationship needed to group its printing-specific
-- facts without joining Catalog during a private read. Current writes record this derived
-- reference with the domain record; compatible preparation fills it for older records through
-- Catalog's resolver. It is deliberately separate from receipts, provenance and source archives.
create table if not exists ${usercardsPrivateSchema}.printing_reference (
  printing_id text primary key check (length(printing_id) between 1 and ${identifierLength}),
  card_id text not null check (length(card_id) between 1 and ${identifierLength}),
  prepared_at timestamptz not null default now()
);

create index if not exists printing_reference_card_index
  on ${usercardsPrivateSchema}.printing_reference (card_id, printing_id);

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

create index if not exists copy_account_printing_index
  on ${usercardsPrivateSchema}.copy (account_id, printing_id, copy_id);

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

create index if not exists association_target_index
  on ${usercardsPrivateSchema}.association (account_id, target_level, target_id);

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
  card_id text check (card_id is null or length(card_id) between 1 and ${identifierLength}),
  printing_id text check (printing_id is null or length(printing_id) between 1 and ${identifierLength}),
  finish text check (finish is null or finish in (${finishValues})),
  condition text check (condition in (${conditionValues})),
  quantity integer not null default 1
    check (quantity between 1 and ${USERCARDS_LIMITS.maxAssociationQuantity}),
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
  -- Explicit destination the recorded confirmation applied: an ownership action creates copies,
  -- a tag destination creates or updates the reviewed associations
  -- (docs/user-cards.md#import-and-capture-state).
  destination text not null check (destination in ('ownership', 'tag')),
  destination_tag_id text check (destination_tag_id is null
    or length(destination_tag_id) between 1 and ${identifierLength}),
  input_fingerprint text not null check (length(input_fingerprint) between 1 and ${fingerprintLength}),
  -- Position of the publication that made this outcome's copies visible. A recovered outcome
  -- reports it long after the account published later revisions, so the recorded value stays
  -- permanent with the receipt rather than following the account's current position.
  publication_position bigint check (publication_position is null or publication_position > 0),
  created_at timestamptz not null default now(),
  primary key (account_id, operation_id),
  check ((destination = 'tag') = (destination_tag_id is not null)),
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

-- The association outcome of one tag-destination confirmation, recorded as the association was
-- when the confirmation committed. A later correction or removal of the association changes the
-- association, never what the recorded receipt reports
-- (docs/user-cards.md#import-and-capture-state).
create table if not exists ${usercardsPrivateSchema}.import_receipt_association (
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  operation_id text not null check (length(operation_id) between 1 and ${identifierLength}),
  association_id text not null check (length(association_id) between 1 and ${identifierLength}),
  record jsonb not null,
  primary key (account_id, operation_id, association_id),
  foreign key (account_id, operation_id)
    references ${usercardsPrivateSchema}.import_receipt (account_id, operation_id)
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

-- One recorded migration per verified source snapshot (docs/migration.md#rehearsal-and-execution-gates).
-- The migration row carries what identifies the loaded artifact; the archive rows carry the exact
-- source evidence the plan's source digest covers, and the batch rows are the replay receipts that
-- make a repeated or interrupted load repeat-safe. Loaded records are read through current queries.
create table if not exists ${usercardsPrivateSchema}.migration (
  account_id text not null check (length(account_id) between 1 and ${identifierLength}),
  migration_id text not null check (length(migration_id) between 1 and ${identifierLength}),
  -- Digest of the verified prepared plan and of the source archive it was converted from. A plan
  -- presented under a recorded snapshot identity must match both.
  plan_digest text not null check (length(plan_digest) between 1 and ${fingerprintLength}),
  source_digest text not null check (length(source_digest) between 1 and ${fingerprintLength}),
  batch_count integer not null check (batch_count >= 0),
  state text not null default 'loading' check (state in ('loading', 'completed')),
  -- Position of the last query-visible batch; null while the plan published no query-visible record.
  publication_position bigint check (publication_position is null or publication_position > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (account_id, migration_id)
);

-- The durable source evidence, in bounded chunks whose concatenation is the canonical archive the
-- plan's source digest covers. A readback reassembles and digests them, so a changed archive fails
-- reconciliation instead of passing silently.
create table if not exists ${usercardsPrivateSchema}.migration_archive (
  account_id text not null,
  migration_id text not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null
    check (length(content) between 1 and ${USERCARDS_LIMITS.maxMigrationArchiveChunkLength}),
  primary key (account_id, migration_id, chunk_index),
  foreign key (account_id, migration_id)
    references ${usercardsPrivateSchema}.migration (account_id, migration_id)
);

-- One committed batch of a migration: the digest of exactly the records it wrote and the position
-- of the publication that made them visible. It commits in the same transaction as those records,
-- so a retry skips a completed identical batch and resumes at the first missing one.
create table if not exists ${usercardsPrivateSchema}.migration_batch (
  account_id text not null,
  migration_id text not null,
  batch_index integer not null check (batch_index >= 0),
  kind text not null check (kind in ('tags', 'copies', 'associations', 'sessions', 'entries')),
  fingerprint text not null check (length(fingerprint) between 1 and ${fingerprintLength}),
  publication_position bigint check (publication_position is null or publication_position > 0),
  created_at timestamptz not null default now(),
  primary key (account_id, migration_id, batch_index),
  foreign key (account_id, migration_id)
    references ${usercardsPrivateSchema}.migration (account_id, migration_id)
);

-- The provider-owned current-query capability reads only these account-scoped relations. They
-- retain the storage columns its query construction needs while preventing its database role from
-- selecting another account's base records directly. Stable references are visible only when the
-- bound account has a copy or printing association that requires them.
create or replace view ${usercardsCurrentQuerySchema}.account_state with (security_barrier) as
  -- Preserve the installed view shape during compatible upgrades; no retention state is used.
  select account_id, revision, 0::bigint as expired_below
  from ${usercardsPrivateSchema}.account_state
  where account_id = ${boundAccountSql};

create or replace view ${usercardsCurrentQuerySchema}.printing_reference with (security_barrier) as
  select reference.printing_id, reference.card_id
  from ${usercardsPrivateSchema}.printing_reference as reference
  where exists (
    select 1 from ${usercardsPrivateSchema}.copy as copy
     where copy.account_id = ${boundAccountSql}
       and copy.printing_id = reference.printing_id
  ) or exists (
    select 1 from ${usercardsPrivateSchema}.association as association
     where association.account_id = ${boundAccountSql}
       and association.target_level = 'printing'
       and association.target_id = reference.printing_id
  );

create or replace view ${usercardsCurrentQuerySchema}.copy with (security_barrier) as
  select copy_id, account_id, printing_id, finish, condition, revision
  from ${usercardsPrivateSchema}.copy
  where account_id = ${boundAccountSql};

create or replace view ${usercardsCurrentQuerySchema}.tag with (security_barrier) as
  select tag_id, account_id, kind, label, system, revision
  from ${usercardsPrivateSchema}.tag
  where account_id = ${boundAccountSql};

create or replace view ${usercardsCurrentQuerySchema}.association with (security_barrier) as
  select association_id, account_id, tag_id, tag_kind, target_level, target_id, quantity, revision
  from ${usercardsPrivateSchema}.association
  where account_id = ${boundAccountSql};

revoke all on schema ${usercardsPrivateSchema} from public;
revoke all on schema ${usercardsCurrentQuerySchema} from public;
`.trim();

const readerRolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants the provider-owned current query capability read-only access to exactly the authoritative
 * relations it evaluates. Import state, receipts, provenance, archives and all mutations remain
 * unavailable; the capability itself owns trusted account scoping.
 */
export function usercardsQueryGrants(role: string): string {
  assertRole(role);
  return [
    `grant usage on schema ${usercardsCurrentQuerySchema} to "${role}";`,
    `grant select on ${usercardsCurrentQuerySchema}.account_state, ${usercardsCurrentQuerySchema}.printing_reference, ${usercardsCurrentQuerySchema}.copy, ${usercardsCurrentQuerySchema}.tag, ${usercardsCurrentQuerySchema}.association to "${role}";`,
  ].join('\n');
}

function assertRole(role: string): void {
  if (!readerRolePattern.test(role)) {
    throw new TypeError(
      `UserCards role must be a lowercase PostgreSQL identifier, received "${role}".`,
    );
  }
}
