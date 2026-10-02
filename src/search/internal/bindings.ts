/**
 * Publication bindings (docs/search.md#internal-design): the mapping from the records Catalog and
 * UserCards publish to the rows of Search's own projection.
 *
 * Bindings translate provider-owned records into the projection schema; they never read a
 * provider table and never accept a caller's SQL. The provider validates its own records before
 * publishing them, so the binding maps the typed record and lets the projection's constraints
 * reject anything the contract does not promise; a record whose identity does not match the
 * change that carries it is unreadable instead of a silent overwrite. Arrays travel as one text
 * parameter and are cast in the statement, because the deployed database transport carries
 * scalars only.
 */

import type {
  CatalogPublishedRecord,
  CatalogRecordChange,
  CatalogRecordReference,
} from '../../catalog/index.js';
import type {
  UserCardsPublishedRecord,
  UserCardsRecordChange,
  UserCardsRecordReference,
} from '../../usercards/index.js';

import { SearchError } from './errors.js';
import type { SearchSqlExecutor, SearchSqlValue } from './executor.js';
import { searchPrivateSchema } from './schema.js';

const generation = 'cast(:generation_id as bigint)';

const catalogBatchStatements = {
  cards: `insert into ${searchPrivateSchema}.card as stored (
      generation_id, card_id, name, rules_text, type_line, colors, color_identity, mana_value
    )
    select ${generation}, entry.card_id, entry.name, entry.rules_text, entry.type_line,
           entry.colors, entry.color_identity, entry.mana_value
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        card_id text, name text, rules_text text, type_line text, colors text[],
        color_identity text[], mana_value numeric
      )
    on conflict (generation_id, card_id) do update set
      name = excluded.name, rules_text = excluded.rules_text, type_line = excluded.type_line,
      colors = excluded.colors, color_identity = excluded.color_identity,
      mana_value = excluded.mana_value`,
  cardNames: `insert into ${searchPrivateSchema}.card_name (
      generation_id, card_id, language, name
    )
    select ${generation}, entry.card_id, entry.language, entry.name
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        card_id text, language text, name text
      )
    on conflict (generation_id, card_id, language, name) do nothing`,
  printings: `insert into ${searchPrivateSchema}.printing as stored (
      generation_id, printing_id, card_id, edition, collector_number, language, finishes, physical
    )
    select ${generation}, entry.printing_id, entry.card_id, entry.edition,
           entry.collector_number, entry.language, entry.finishes, entry.physical
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        printing_id text, card_id text, edition text, collector_number text, language text,
        finishes text[], physical boolean
      )
    on conflict (generation_id, printing_id) do update set
      card_id = excluded.card_id, edition = excluded.edition,
      collector_number = excluded.collector_number, language = excluded.language,
      finishes = excluded.finishes, physical = excluded.physical`,
  deleteCards: `delete from ${searchPrivateSchema}.card
    where generation_id = ${generation}
      and card_id in (select jsonb_array_elements_text(cast(:batch as jsonb)))`,
  deleteCardNames: `delete from ${searchPrivateSchema}.card_name as stored
    using jsonb_to_recordset(cast(:batch as jsonb)) as entry(
      card_id text, language text, name text
    )
    where stored.generation_id = ${generation} and stored.card_id = entry.card_id
      and stored.language = entry.language and stored.name = entry.name`,
  deletePrintings: `delete from ${searchPrivateSchema}.printing
    where generation_id = ${generation}
      and printing_id in (select jsonb_array_elements_text(cast(:batch as jsonb)))`,
} as const;

const userCardsBatchStatements = {
  copies: `insert into ${searchPrivateSchema}.copy as stored (
      generation_id, account_id, copy_id, printing_id, finish, condition, owned, location_id
    )
    select ${generation}, :account_id, entry.copy_id, entry.printing_id, entry.finish,
           entry.condition, entry.owned, entry.location_id
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        copy_id text, printing_id text, finish text, condition text, owned boolean, location_id text
      )
    on conflict (generation_id, account_id, copy_id) do update set
      printing_id = excluded.printing_id, finish = excluded.finish,
      condition = excluded.condition, owned = excluded.owned, location_id = excluded.location_id`,
  tags: `insert into ${searchPrivateSchema}.tag as stored (
      generation_id, account_id, tag_id, kind, label, system
    )
    select ${generation}, :account_id, entry.tag_id, entry.kind, entry.label, entry.system
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        tag_id text, kind text, label text, system boolean
      )
    on conflict (generation_id, account_id, tag_id) do update set
      kind = excluded.kind, label = excluded.label, system = excluded.system`,
  associations: `insert into ${searchPrivateSchema}.association as stored (
      generation_id, account_id, association_id, tag_id, target_level, target_id, quantity
    )
    select ${generation}, :account_id, entry.association_id, entry.tag_id,
           entry.target_level, entry.target_id, entry.quantity
      from jsonb_to_recordset(cast(:batch as jsonb)) as entry(
        association_id text, tag_id text, target_level text, target_id text, quantity integer
      )
    on conflict (generation_id, account_id, association_id) do update set
      tag_id = excluded.tag_id, target_level = excluded.target_level,
      target_id = excluded.target_id, quantity = excluded.quantity`,
  deleteCopies: `delete from ${searchPrivateSchema}.copy
    where generation_id = ${generation} and account_id = :account_id
      and copy_id in (select jsonb_array_elements_text(cast(:batch as jsonb)))`,
  deleteTags: `delete from ${searchPrivateSchema}.tag
    where generation_id = ${generation} and account_id = :account_id
      and tag_id in (select jsonb_array_elements_text(cast(:batch as jsonb)))`,
  deleteAssociations: `delete from ${searchPrivateSchema}.association
    where generation_id = ${generation} and account_id = :account_id
      and association_id in (select jsonb_array_elements_text(cast(:batch as jsonb)))`,
} as const;

/** Applies a bounded set of catalog changes with a constant number of remote SQL requests. */
export async function applyCatalogRecordChanges(
  sql: SearchSqlExecutor,
  generationId: string,
  changes: readonly CatalogRecordChange[],
): Promise<void> {
  const records: CatalogPublishedRecord[] = [];
  const removed: CatalogRecordReference[] = [];
  for (const change of changes) {
    if (change.removed || change.record === null) {
      removed.push(change.reference);
    } else {
      if (
        change.record.kind !== change.kind ||
        !sameCatalogIdentity(change.reference, change.record)
      ) {
        throw unreadable();
      }
      records.push(change.record);
    }
  }
  await writeCatalogRecords(sql, generationId, records);
  await deleteCatalogRecords(sql, generationId, removed);
}

/** Applies a bounded set of private changes with a constant number of remote SQL requests. */
export async function applyUserCardsRecordChanges(
  sql: SearchSqlExecutor,
  generationId: string,
  accountId: string,
  changes: readonly UserCardsRecordChange[],
): Promise<void> {
  const records: UserCardsPublishedRecord[] = [];
  const removed: UserCardsRecordReference[] = [];
  for (const change of changes) {
    if (change.accountId !== accountId) throw unreadable();
    if (change.removed || change.record === null) {
      removed.push(change.reference);
    } else {
      if (
        change.record.kind !== change.kind ||
        !sameUserCardsIdentity(change.reference, change.record)
      ) {
        throw unreadable();
      }
      records.push(change.record);
    }
  }
  await writeUserCardsRecords(sql, generationId, accountId, records);
  await deleteUserCardsRecords(sql, generationId, accountId, removed);
}

/** Writes one bounded catalog batch set-wise, grouped by projection relation. */
export async function writeCatalogRecords(
  sql: SearchSqlExecutor,
  generationId: string,
  records: readonly CatalogPublishedRecord[],
): Promise<void> {
  const cards: unknown[] = [];
  const names: unknown[] = [];
  const printings: unknown[] = [];
  for (const record of records) {
    switch (record.kind) {
      case 'card':
        cards.push({
          card_id: record.card.cardId,
          name: record.card.name,
          rules_text: record.card.rulesText,
          type_line: record.card.typeLine,
          colors: record.card.colors,
          color_identity: record.card.colorIdentity,
          mana_value: record.card.manaValue,
        });
        break;
      case 'card-name':
        names.push({
          card_id: record.name.cardId,
          language: record.name.language,
          name: record.name.name,
        });
        break;
      case 'printing':
        printings.push({
          printing_id: record.printing.printingId,
          card_id: record.printing.cardId,
          edition: record.printing.edition,
          collector_number: record.printing.collectorNumber,
          language: record.printing.language,
          finishes: record.printing.finishes,
          physical: record.printing.physical,
        });
        break;
    }
  }
  await writeJsonBatch(sql, catalogBatchStatements.cards, generationId, cards);
  await writeJsonBatch(sql, catalogBatchStatements.cardNames, generationId, names);
  await writeJsonBatch(sql, catalogBatchStatements.printings, generationId, printings);
}

/** Writes one bounded private batch set-wise, grouped by projection relation. */
export async function writeUserCardsRecords(
  sql: SearchSqlExecutor,
  generationId: string,
  accountId: string,
  records: readonly UserCardsPublishedRecord[],
): Promise<void> {
  const copies: unknown[] = [];
  const tags: unknown[] = [];
  const associations: unknown[] = [];
  for (const record of records) {
    switch (record.kind) {
      case 'copy':
        copies.push({
          copy_id: record.copy.copyId,
          printing_id: record.copy.printingId,
          finish: record.copy.finish,
          condition: record.copy.condition,
          owned: record.copy.owned,
          location_id: record.copy.locationId,
        });
        break;
      case 'tag':
        tags.push({
          tag_id: record.tag.tagId,
          kind: record.tag.kind,
          label: record.tag.label,
          system: record.tag.system,
        });
        break;
      case 'association':
        associations.push({
          association_id: record.association.associationId,
          tag_id: record.association.tagId,
          target_level: record.association.targetLevel,
          target_id: record.association.targetId,
          quantity: record.association.quantity,
        });
        break;
    }
  }
  const extra = { account_id: accountId };
  await writeJsonBatch(sql, userCardsBatchStatements.copies, generationId, copies, extra);
  await writeJsonBatch(sql, userCardsBatchStatements.tags, generationId, tags, extra);
  await writeJsonBatch(
    sql,
    userCardsBatchStatements.associations,
    generationId,
    associations,
    extra,
  );
}

async function deleteCatalogRecords(
  sql: SearchSqlExecutor,
  generationId: string,
  references: readonly CatalogRecordReference[],
): Promise<void> {
  const cards: string[] = [];
  const names: unknown[] = [];
  const printings: string[] = [];
  for (const reference of references) {
    switch (reference.kind) {
      case 'card':
        cards.push(reference.cardId);
        break;
      case 'card-name':
        names.push({
          card_id: reference.cardId,
          language: reference.language,
          name: reference.name,
        });
        break;
      case 'printing':
        printings.push(reference.printingId);
        break;
    }
  }
  await writeJsonBatch(sql, catalogBatchStatements.deleteCards, generationId, cards);
  await writeJsonBatch(sql, catalogBatchStatements.deleteCardNames, generationId, names);
  await writeJsonBatch(sql, catalogBatchStatements.deletePrintings, generationId, printings);
}

async function deleteUserCardsRecords(
  sql: SearchSqlExecutor,
  generationId: string,
  accountId: string,
  references: readonly UserCardsRecordReference[],
): Promise<void> {
  const copies: string[] = [];
  const tags: string[] = [];
  const associations: string[] = [];
  for (const reference of references) {
    switch (reference.kind) {
      case 'copy':
        copies.push(reference.copyId);
        break;
      case 'tag':
        tags.push(reference.tagId);
        break;
      case 'association':
        associations.push(reference.associationId);
        break;
    }
  }
  const extra = { account_id: accountId };
  await writeJsonBatch(sql, userCardsBatchStatements.deleteCopies, generationId, copies, extra);
  await writeJsonBatch(sql, userCardsBatchStatements.deleteTags, generationId, tags, extra);
  await writeJsonBatch(
    sql,
    userCardsBatchStatements.deleteAssociations,
    generationId,
    associations,
    extra,
  );
}

async function writeJsonBatch(
  sql: SearchSqlExecutor,
  statement: string,
  generationId: string,
  entries: readonly unknown[],
  extra: Readonly<Record<string, SearchSqlValue>> = {},
): Promise<void> {
  if (entries.length === 0) return;
  await write(sql, statement, {
    generation_id: generationId,
    batch: JSON.stringify(entries),
    ...extra,
  });
}

/** Whether a decoded record still carries the stable identity its change was published under. */
function sameCatalogIdentity(
  reference: CatalogRecordReference,
  record: CatalogPublishedRecord,
): boolean {
  switch (reference.kind) {
    case 'card':
      return record.kind === 'card' && record.card.cardId === reference.cardId;
    case 'printing':
      return record.kind === 'printing' && record.printing.printingId === reference.printingId;
    case 'card-name':
      return (
        record.kind === 'card-name' &&
        record.name.cardId === reference.cardId &&
        record.name.language === reference.language &&
        record.name.name === reference.name
      );
  }
}

function sameUserCardsIdentity(
  reference: UserCardsRecordReference,
  record: UserCardsPublishedRecord,
): boolean {
  switch (reference.kind) {
    case 'copy':
      return record.kind === 'copy' && record.copy.copyId === reference.copyId;
    case 'tag':
      return record.kind === 'tag' && record.tag.tagId === reference.tagId;
    case 'association':
      return (
        record.kind === 'association' &&
        record.association.associationId === reference.associationId
      );
  }
}

async function write(
  sql: SearchSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, SearchSqlValue>>,
): Promise<void> {
  try {
    await sql.query(statement, parameters);
  } catch (cause) {
    throw new SearchError('unavailable', 'The published record could not be projected.', {
      cause,
    });
  }
}

function unreadable(): SearchError {
  return new SearchError(
    'unavailable',
    'A published record does not match the identity its change carries.',
  );
}
