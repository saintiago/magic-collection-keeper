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

const catalogStatements = {
  cardUpsert: `insert into ${searchPrivateSchema}.card (
      generation_id, card_id, name, rules_text, type_line, colors, color_identity, mana_value
    ) values (
      ${generation}, :card_id, :name, :rules_text, :type_line,
      cast(:colors as text[]), cast(:color_identity as text[]), cast(:mana_value as numeric)
    )
    on conflict (generation_id, card_id) do update set
      name = excluded.name,
      rules_text = excluded.rules_text,
      type_line = excluded.type_line,
      colors = excluded.colors,
      color_identity = excluded.color_identity,
      mana_value = excluded.mana_value`,
  cardDelete: `delete from ${searchPrivateSchema}.card
    where generation_id = ${generation} and card_id = :card_id`,
  cardNameUpsert: `insert into ${searchPrivateSchema}.card_name (
      generation_id, card_id, language, name
    ) values (${generation}, :card_id, :language, :name)
    on conflict (generation_id, card_id, language, name) do nothing`,
  cardNameDelete: `delete from ${searchPrivateSchema}.card_name
    where generation_id = ${generation}
      and card_id = :card_id and language = :language and name = :name`,
  printingUpsert: `insert into ${searchPrivateSchema}.printing (
      generation_id, printing_id, card_id, edition, collector_number, language, finishes, physical
    ) values (
      ${generation}, :printing_id, :card_id, :edition, :collector_number, :language,
      cast(:finishes as text[]), :physical
    )
    on conflict (generation_id, printing_id) do update set
      card_id = excluded.card_id,
      edition = excluded.edition,
      collector_number = excluded.collector_number,
      language = excluded.language,
      finishes = excluded.finishes,
      physical = excluded.physical`,
  printingDelete: `delete from ${searchPrivateSchema}.printing
    where generation_id = ${generation} and printing_id = :printing_id`,
} as const;

const userCardsStatements = {
  copyUpsert: `insert into ${searchPrivateSchema}.copy (
      generation_id, account_id, copy_id, printing_id, finish, condition, owned, location_id
    ) values (
      ${generation}, :account_id, :copy_id, :printing_id, :finish, :condition, :owned,
      :location_id
    )
    on conflict (generation_id, account_id, copy_id) do update set
      printing_id = excluded.printing_id,
      finish = excluded.finish,
      condition = excluded.condition,
      owned = excluded.owned,
      location_id = excluded.location_id`,
  copyDelete: `delete from ${searchPrivateSchema}.copy
    where generation_id = ${generation} and account_id = :account_id and copy_id = :copy_id`,
  tagUpsert: `insert into ${searchPrivateSchema}.tag (
      generation_id, account_id, tag_id, kind, label, system
    ) values (${generation}, :account_id, :tag_id, :kind, :label, :system)
    on conflict (generation_id, account_id, tag_id) do update set
      kind = excluded.kind,
      label = excluded.label,
      system = excluded.system`,
  tagDelete: `delete from ${searchPrivateSchema}.tag
    where generation_id = ${generation} and account_id = :account_id and tag_id = :tag_id`,
  associationUpsert: `insert into ${searchPrivateSchema}.association (
      generation_id, account_id, association_id, tag_id, target_level, target_id, quantity
    ) values (
      ${generation}, :account_id, :association_id, :tag_id, :target_level, :target_id, :quantity
    )
    on conflict (generation_id, account_id, association_id) do update set
      tag_id = excluded.tag_id,
      target_level = excluded.target_level,
      target_id = excluded.target_id,
      quantity = excluded.quantity`,
  associationDelete: `delete from ${searchPrivateSchema}.association
    where generation_id = ${generation} and account_id = :account_id
      and association_id = :association_id`,
} as const;

/** Applies one published catalog record change to one generation of the projection. */
export async function applyCatalogRecordChange(
  sql: SearchSqlExecutor,
  generationId: string,
  change: CatalogRecordChange,
): Promise<void> {
  const record = change.record;
  if (change.removed || record === null) {
    await deleteCatalogRecord(sql, generationId, change.reference);
    return;
  }
  if (record.kind !== change.kind || !sameCatalogIdentity(change.reference, record)) {
    throw unreadable();
  }
  await writeCatalogRecord(sql, generationId, record);
}

/** Applies one published private record change to one generation of the projection. */
export async function applyUserCardsRecordChange(
  sql: SearchSqlExecutor,
  generationId: string,
  change: UserCardsRecordChange,
): Promise<void> {
  const record = change.record;
  if (change.removed || record === null) {
    await deleteUserCardsRecord(sql, generationId, change.accountId, change.reference);
    return;
  }
  if (record.kind !== change.kind || !sameUserCardsIdentity(change.reference, record)) {
    throw unreadable();
  }
  await writeUserCardsRecord(sql, generationId, change.accountId, record);
}

/** Writes one published catalog record of a snapshot or an upsert change into the projection. */
export async function writeCatalogRecord(
  sql: SearchSqlExecutor,
  generationId: string,
  record: CatalogPublishedRecord,
): Promise<void> {
  switch (record.kind) {
    case 'card':
      await write(sql, catalogStatements.cardUpsert, {
        generation_id: generationId,
        card_id: record.card.cardId,
        name: record.card.name,
        rules_text: record.card.rulesText,
        type_line: record.card.typeLine,
        colors: textArray(record.card.colors),
        color_identity: textArray(record.card.colorIdentity),
        mana_value: record.card.manaValue,
      });
      return;
    case 'card-name':
      await write(sql, catalogStatements.cardNameUpsert, {
        generation_id: generationId,
        card_id: record.name.cardId,
        language: record.name.language,
        name: record.name.name,
      });
      return;
    case 'printing':
      await write(sql, catalogStatements.printingUpsert, {
        generation_id: generationId,
        printing_id: record.printing.printingId,
        card_id: record.printing.cardId,
        edition: record.printing.edition,
        collector_number: record.printing.collectorNumber,
        language: record.printing.language,
        finishes: textArray(record.printing.finishes),
        physical: record.printing.physical,
      });
      return;
  }
}

/** Writes one published private record of a snapshot or an upsert change into the projection. */
export async function writeUserCardsRecord(
  sql: SearchSqlExecutor,
  generationId: string,
  accountId: string,
  record: UserCardsPublishedRecord,
): Promise<void> {
  switch (record.kind) {
    case 'copy':
      await write(sql, userCardsStatements.copyUpsert, {
        generation_id: generationId,
        account_id: accountId,
        copy_id: record.copy.copyId,
        printing_id: record.copy.printingId,
        finish: record.copy.finish,
        condition: record.copy.condition,
        owned: record.copy.owned,
        location_id: record.copy.locationId,
      });
      return;
    case 'tag':
      await write(sql, userCardsStatements.tagUpsert, {
        generation_id: generationId,
        account_id: accountId,
        tag_id: record.tag.tagId,
        kind: record.tag.kind,
        label: record.tag.label,
        system: record.tag.system,
      });
      return;
    case 'association':
      await write(sql, userCardsStatements.associationUpsert, {
        generation_id: generationId,
        account_id: accountId,
        association_id: record.association.associationId,
        tag_id: record.association.tagId,
        target_level: record.association.targetLevel,
        target_id: record.association.targetId,
        quantity: record.association.quantity,
      });
      return;
  }
}

async function deleteCatalogRecord(
  sql: SearchSqlExecutor,
  generationId: string,
  reference: CatalogRecordReference,
): Promise<void> {
  switch (reference.kind) {
    case 'card':
      await write(sql, catalogStatements.cardDelete, {
        generation_id: generationId,
        card_id: reference.cardId,
      });
      return;
    case 'card-name':
      await write(sql, catalogStatements.cardNameDelete, {
        generation_id: generationId,
        card_id: reference.cardId,
        language: reference.language,
        name: reference.name,
      });
      return;
    case 'printing':
      await write(sql, catalogStatements.printingDelete, {
        generation_id: generationId,
        printing_id: reference.printingId,
      });
      return;
  }
}

async function deleteUserCardsRecord(
  sql: SearchSqlExecutor,
  generationId: string,
  accountId: string,
  reference: UserCardsRecordReference,
): Promise<void> {
  switch (reference.kind) {
    case 'copy':
      await write(sql, userCardsStatements.copyDelete, {
        generation_id: generationId,
        account_id: accountId,
        copy_id: reference.copyId,
      });
      return;
    case 'tag':
      await write(sql, userCardsStatements.tagDelete, {
        generation_id: generationId,
        account_id: accountId,
        tag_id: reference.tagId,
      });
      return;
    case 'association':
      await write(sql, userCardsStatements.associationDelete, {
        generation_id: generationId,
        account_id: accountId,
        association_id: reference.associationId,
      });
      return;
  }
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

/**
 * One text array as a PostgreSQL array literal. The deployed transport carries scalars only, so
 * the literal travels as text and the statement casts it; every element is quoted and escaped, so
 * a value the provider published can never change the literal's structure.
 */
function textArray(values: readonly string[]): string {
  const elements = values.map((value) => `"${value.replace(/([\\"])/gu, '\\$1')}"`);
  return `{${elements.join(',')}}`;
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
