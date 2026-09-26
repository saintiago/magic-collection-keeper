/**
 * Catalog contract fixtures over the shared in-process PostgreSQL harness
 * (tests/support/postgres-database.ts): the catalog schema, an executor in the shape Application
 * supplies, and a fixture writer for tests that need published rows without provider snapshots.
 */

import {
  CatalogError,
  catalogSchemaSql,
  type CatalogSqlTransactor,
} from '../../src/catalog/index.js';
import { createTestDatabase, type TestDatabase } from './postgres-database.js';

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

export interface CatalogTestDatabase extends TestDatabase {
  /** Executor in the shape Application supplies to createCatalog. */
  readonly sql: CatalogSqlTransactor;
}

export async function createCatalogTestDatabase(): Promise<CatalogTestDatabase> {
  return createTestDatabase(catalogSchemaSql);
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

/**
 * Replaces the published revision in one transaction for tests that need published rows without
 * provider snapshots. Read-contract cases use this fixture writer; synchronization cases publish
 * through createCatalogSynchronizer.
 */
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
