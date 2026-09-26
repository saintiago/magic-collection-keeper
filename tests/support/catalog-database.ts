/**
 * Test harness for the catalog query surface. PGlite is PostgreSQL compiled to WebAssembly, so
 * these tests exercise real PostgreSQL semantics — views, constraints, privileges, MVCC snapshots
 * — in-process, without a database service. Production runs the same statements through the RDS
 * Data API executor Application supplies.
 */

import { PGlite } from '@electric-sql/pglite';

import {
  CatalogError,
  catalogSchemaSql,
  type CatalogSqlExecutor,
  type CatalogSqlValue,
} from '../../src/catalog/index.js';

/** Returns the CatalogError a call rejects with; fails the test for any other outcome. */
export async function captureCatalogError(promise: Promise<unknown>): Promise<CatalogError> {
  const outcome = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(outcome instanceof CatalogError)) {
    throw new Error(`Expected a CatalogError, received ${String(outcome)}.`);
  }
  return outcome;
}

export interface CatalogTestDatabase {
  /** Executor in the shape Application supplies to createCatalog. */
  readonly sql: CatalogSqlExecutor;
  exec(statement: string): Promise<void>;
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
}

export async function createCatalogTestDatabase(): Promise<CatalogTestDatabase> {
  const database = new PGlite();
  try {
    await database.exec(catalogSchemaSql);
  } catch (error) {
    await database.close();
    throw error;
  }
  return {
    sql: {
      async query(statement, parameters = {}) {
        const bound = bindNamedParameters(statement, parameters);
        const result = await database.query<Record<string, CatalogSqlValue>>(
          bound.text,
          bound.values,
        );
        return result.rows;
      },
    },
    async exec(statement) {
      await database.exec(statement);
    },
    async query(statement, values = []) {
      const result = await database.query<Record<string, unknown>>(statement, [...values]);
      return result.rows;
    },
    close: () => database.close(),
  };
}

/** Replaces `:name` placeholders with positional parameters; `::` casts and quoted text survive. */
export function bindNamedParameters(
  statement: string,
  parameters: Readonly<Record<string, CatalogSqlValue>>,
): { text: string; values: CatalogSqlValue[] } {
  const used: string[] = [];
  const values: CatalogSqlValue[] = [];
  let text = '';
  let index = 0;
  while (index < statement.length) {
    const character = statement[index];
    if (character === undefined) {
      break;
    }
    if (character === "'") {
      const end = statement.indexOf("'", index + 1);
      if (end === -1) {
        throw new Error('Test statement has an unterminated text literal.');
      }
      text += statement.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (character === ':' && statement[index + 1] === ':') {
      text += '::';
      index += 2;
      continue;
    }
    if (character === ':' && /[A-Za-z_]/.test(statement[index + 1] ?? '')) {
      let end = index + 2;
      while (end < statement.length && /[A-Za-z0-9_]/.test(statement[end] ?? '')) {
        end += 1;
      }
      const name = statement.slice(index + 1, end);
      const value = parameters[name];
      if (value === undefined) {
        throw new Error(`Test statement references unbound parameter :${name}.`);
      }
      used.push(name);
      values.push(value);
      text += `$${values.length}`;
      index = end;
      continue;
    }
    text += character;
    index += 1;
  }
  const unused = Object.keys(parameters).filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new Error(`Test statement ignores bound parameters: ${unused.join(', ')}.`);
  }
  return { text, values };
}

export interface CardFixture {
  readonly cardId: string;
  readonly name: string;
  readonly names?: readonly { readonly language: string; readonly name: string }[];
  readonly rulesText?: string | null;
  readonly typeLine?: string | null;
  readonly colors?: readonly string[];
  readonly colorIdentity?: readonly string[];
  readonly manaValue?: number | null;
}

export interface PrintingFixture {
  readonly printingId: string;
  readonly cardId: string;
  readonly edition: string;
  readonly collectorNumber: string;
  readonly language: string;
  readonly finishes?: readonly string[];
  readonly physical?: boolean;
  readonly images?: {
    readonly small?: string | null;
    readonly normal?: string | null;
    readonly large?: string | null;
    readonly artCrop?: string | null;
  };
}

export interface CatalogFixture {
  readonly revisionId: string;
  readonly sourceName?: string;
  readonly sourceVersion?: string;
  readonly publishedAt?: string;
  readonly cards: readonly CardFixture[];
  readonly printings: readonly PrintingFixture[];
}

/** Replaces the published revision in one transaction, like a catalog synchronization does. */
export async function publishCatalog(
  database: CatalogTestDatabase,
  fixture: CatalogFixture,
): Promise<void> {
  await database.exec('begin');
  try {
    await database.exec(
      'delete from catalog_private.card_name; delete from catalog_private.printing; delete from catalog_private.card;',
    );
    for (const card of fixture.cards) {
      await database.query(
        `insert into catalog_private.card
           (card_id, name, rules_text, type_line, colors, color_identity, mana_value)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          card.cardId,
          card.name,
          card.rulesText ?? null,
          card.typeLine ?? null,
          card.colors ?? [],
          card.colorIdentity ?? [],
          card.manaValue ?? null,
        ],
      );
      for (const alias of card.names ?? []) {
        await database.query(
          'insert into catalog_private.card_name (card_id, language, name) values ($1, $2, $3)',
          [card.cardId, alias.language, alias.name],
        );
      }
    }
    for (const printing of fixture.printings) {
      await database.query(
        `insert into catalog_private.printing
           (printing_id, card_id, edition, collector_number, language, finishes, physical,
            image_small, image_normal, image_large, image_art_crop)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          printing.printingId,
          printing.cardId,
          printing.edition,
          printing.collectorNumber,
          printing.language,
          printing.finishes ?? ['nonfoil'],
          printing.physical ?? true,
          printing.images?.small ?? null,
          printing.images?.normal ?? null,
          printing.images?.large ?? null,
          printing.images?.artCrop ?? null,
        ],
      );
    }
    await database.query(
      `insert into catalog_private.revision
         (singleton, revision_id, source_name, source_version, published_at)
       values (true, $1, $2, $3, $4)
       on conflict (singleton) do update set
         revision_id = excluded.revision_id,
         source_name = excluded.source_name,
         source_version = excluded.source_version,
         published_at = excluded.published_at`,
      [
        fixture.revisionId,
        fixture.sourceName ?? 'scryfall',
        fixture.sourceVersion ?? '2026-09-26',
        fixture.publishedAt ?? '2026-09-26T20:00:00.000Z',
      ],
    );
    await database.exec('commit');
  } catch (error) {
    await database.exec('rollback');
    throw error;
  }
}
