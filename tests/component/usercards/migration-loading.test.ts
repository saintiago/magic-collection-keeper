/**
 * Component scope: the UserCards-owned migration loader and its private readback
 * (docs/user-cards.md#interface, docs/migration.md#rehearsal-and-execution-gates). A verified
 * prepared plan loads into an empty account as repeat-safe batches, publishes its query-visible
 * records normally, retains its source archive durably, refuses conflicting or nonempty input and
 * resumes an interrupted run at its first missing batch. Synthetic legacy records only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  createUserCards,
  createUserCardsPublication,
  type TrustedUserContext,
  type UserCards,
  type UserCardsPublication,
  type UserCardsPublishedRecord,
  type UserCardsSqlTransactor,
  type UserCardsSqlValue,
} from '../../../src/usercards/index.js';
import { bundle, legacyRevision, stableId } from '../../../scripts/migration/legacy.js';
import { prepareMigration } from '../../../scripts/migration/prepare.js';
import { reconcileMigration } from '../../../scripts/migration/reconcile.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';
import { callerInput } from './harness.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const boltPrinting = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

/** One synthetic legacy export: ownership, a deck requirement, a location and a pending import. */
function legacyExport(
  options: {
    readonly quantity?: number;
    readonly snapshotId?: string;
    readonly accountId?: string;
    readonly finish?: 'nonfoil' | 'foil';
  } = {},
) {
  return bundle.parse({
    format: 'keeper-legacy-export-v1',
    legacyRevision,
    snapshotId: options.snapshotId ?? 'synthetic-snapshot',
    catalog: [
      {
        printingId: boltPrinting.printingId,
        cardId: boltPrinting.cardId,
        language: boltPrinting.language,
        finishes: ['nonfoil', 'foil'],
        paper: true,
      },
    ],
    accounts: [
      {
        owner: 'alice',
        accountId: options.accountId ?? alice.accountId,
        inventory: [
          {
            id: 'native',
            printing_id: boltPrinting.printingId,
            language: 'en',
            finish: options.finish ?? 'nonfoil',
            condition: 'NM',
            quantity: options.quantity ?? 2,
          },
        ],
        documents: [
          {
            space: 'tags',
            id: 'deck',
            version: 1,
            value: { id: 'deck', type: 'location', kind: 'deck', label: 'Bolt deck' },
          },
          {
            space: 'tags',
            id: 'box',
            version: 1,
            value: { id: 'box', type: 'location', kind: 'box', label: 'Cardboard box' },
          },
          {
            space: 'tags',
            id: 'role',
            version: 1,
            value: { id: 'role', type: 'role', kind: 'role', label: 'Removal' },
          },
          {
            space: 'assignments',
            id: 'native',
            version: 1,
            value: {
              locations_override: true,
              locations: [
                { tag_id: 'deck', quantity: 3 },
                { tag_id: 'box', quantity: 1 },
              ],
              tag_ids: ['role'],
            },
          },
          {
            space: 'import-drafts',
            id: 'pending',
            version: 1,
            value: {
              id: 'pending',
              state: 'pending',
              provider: 'reviewed-capture',
              source_id: 'capture:pending',
              rows: [
                {
                  id: 'row-1',
                  printing_id: null,
                  finish: null,
                  quantity: 2,
                  original: { name: 'Unresolved card' },
                },
                {
                  id: 'row-2',
                  printing_id: boltPrinting.printingId,
                  finish: 'foil',
                  condition: 'UNK',
                  quantity: 1,
                  original: { name: 'Lightning Bolt', set: 'M11', collector_number: '149' },
                  recognition_candidates: [
                    {
                      printing_id: boltPrinting.printingId,
                      provider: 'recognition',
                      evidence: 'visual',
                    },
                  ],
                },
              ],
            },
          },
        ],
        operations: [{ id: 'old-operation', fingerprint: 'original-fingerprint' }],
      },
    ],
  });
}

/**
 * Fails one recorded migration batch, like an interruption between batches. Every earlier batch is
 * committed, so a retry must resume at the failed batch instead of writing the account again.
 */
function failBatch(sql: UserCardsSqlTransactor, batchIndex: number): UserCardsSqlTransactor {
  return {
    query: (statement, parameters) => sql.query(statement, parameters),
    transaction: (work) =>
      sql.transaction((statements) =>
        work({
          async query(statement: string, parameters?: Readonly<Record<string, UserCardsSqlValue>>) {
            if (
              statement.includes('insert into usercards_private.migration_batch') &&
              parameters?.batch_index === batchIndex
            ) {
              throw new Error('simulated migration interruption');
            }
            return statements.query(statement, parameters);
          },
        }),
      ),
  };
}

describe('usercards migration loading', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;
  let publication: UserCardsPublication;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [boltPrinting],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
    publication = createUserCardsPublication({ sql: database.sql });
  });

  afterEach(async () => {
    await database.close();
  });

  async function snapshot(accountId: string): Promise<readonly UserCardsPublishedRecord[]> {
    const records: UserCardsPublishedRecord[] = [];
    let continuation: string | undefined;
    do {
      const page = await publication.readSnapshot({
        accountId,
        ...(continuation === undefined ? {} : { continuation }),
      });
      records.push(...page.records);
      continuation = page.continuation ?? undefined;
    } while (continuation !== undefined);
    return records;
  }

  it('loads a verified prepared plan and reconciles its exact records', async () => {
    const plan = prepareMigration(legacyExport());
    expect(plan.state).toBe('prepared');

    const loaded = await userCards.loadMigrationPlan(alice, {
      plan,
      sourceDigest: plan.sourceDigest,
    });
    const batches = loaded.totalBatches;
    expect(batches).toBeGreaterThan(0);
    expect(loaded.appliedBatches).toBe(batches);
    expect(loaded.replayed).toBe(false);
    expect(loaded.publicationPosition).not.toBeNull();

    const readback = await userCards.readMigrationReadback(alice);
    expect(reconcileMigration(plan, [readback])).toEqual([]);
    expect(readback.archiveDigest).toBe(plan.sourceDigest);
    expect(readback.accountId).toBe(alice.accountId);
    expect(readback.copies).toHaveLength(2);
    expect([...readback.ownedCopyIds].sort()).toEqual(
      readback.copies.map((copy) => copy.copyId).sort(),
    );
    expect(readback.tags.every((tag) => !tag.system)).toBe(true);
    expect(readback.tags).toHaveLength(3);
    expect(readback.associations).toHaveLength(4); // One deck requirement and three copy memberships.
    expect(readback.sessions).toHaveLength(1);
    expect(readback.pending).toHaveLength(2);
  });

  it('publishes loaded copies with their ownership and location and keeps pending state private', async () => {
    const plan = prepareMigration(legacyExport());
    await userCards.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest });
    const account = plan.accounts[0]!;

    const records = await snapshot(alice.accountId);
    const copies = records.flatMap((record) => (record.kind === 'copy' ? [record.copy] : []));
    expect(copies.map((copy) => copy.copyId).sort()).toEqual(
      account.copies.map((copy) => copy.copyId).sort(),
    );
    expect(copies.every((copy) => copy.owned)).toBe(true);
    // The physical location publishes with its copy, never on a later association change.
    const assigned = account.associations.find(
      (association) => association.targetLevel === 'copy' && association.quantity === null,
    );
    const locationTag = account.tags.find((tag) => tag.kind === 'location')!;
    const located = copies.find((copy) => copy.copyId === assigned!.targetId);
    expect(located?.locationId).toBe(locationTag.tagId);
    expect(records.filter((record) => record.kind === 'tag')).toHaveLength(4); // System tag included.
    expect(records.filter((record) => record.kind === 'association')).toHaveLength(6);

    const sessions = await userCards.listImportSessions(alice);
    expect(sessions.sessions).toEqual(account.sessions);
    const entries = await userCards.listImportEntries(alice, {
      sessionId: account.sessions[0]!.sessionId,
    });
    expect(entries.entries.map((entry) => entry.entryId)).toEqual(
      account.pending.map((entry) => entry.entryId),
    );
  });

  it('returns the recorded outcome for a repeated identical plan without writing again', async () => {
    const plan = prepareMigration(legacyExport());
    const first = await userCards.loadMigrationPlan(alice, {
      plan,
      sourceDigest: plan.sourceDigest,
    });
    const second = await userCards.loadMigrationPlan(alice, {
      plan,
      sourceDigest: plan.sourceDigest,
    });

    expect(second.replayed).toBe(true);
    expect(second.appliedBatches).toBe(0);
    expect(second.totalBatches).toBe(first.totalBatches);
    expect(second.publicationPosition).toBe(first.publicationPosition);
    const readback = await userCards.readMigrationReadback(alice);
    expect(readback.copies).toHaveLength(2);
    expect(reconcileMigration(plan, [readback])).toEqual([]);
  });

  it('resumes an interrupted load at its first missing batch', async () => {
    const plan = prepareMigration(legacyExport({ quantity: 250 }));
    const interrupted = createUserCards({ sql: failBatch(database.sql, 3), catalog });

    const failure = await captureUserCardsError(
      interrupted.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest }),
    );
    expect(failure.code).toBe('unavailable');
    const partial = await captureUserCardsError(userCards.readMigrationReadback(alice));
    expect(partial.code).toBe('conflict');

    const resumed = await userCards.loadMigrationPlan(alice, {
      plan,
      sourceDigest: plan.sourceDigest,
    });
    expect(resumed.appliedBatches).toBeGreaterThan(0);
    expect(resumed.appliedBatches).toBeLessThan(resumed.totalBatches);
    expect(resumed.replayed).toBe(false);
    const readback = await userCards.readMigrationReadback(alice);
    expect(readback.copies).toHaveLength(250);
    expect(reconcileMigration(plan, [readback])).toEqual([]);
  });

  it('refuses a nonempty target account and a plan that is not the recorded one', async () => {
    await userCards.createCopies(alice, {
      printingId: boltPrinting.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    const plan = prepareMigration(legacyExport());
    const nonempty = await captureUserCardsError(
      userCards.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest }),
    );
    expect(nonempty.code).toBe('conflict');

    // Another account's empty target loads normally and keeps its own migration record.
    const bobPlan = prepareMigration(legacyExport({ accountId: bob.accountId }));
    const bobLoaded = await userCards.loadMigrationPlan(bob, {
      plan: bobPlan,
      sourceDigest: bobPlan.sourceDigest,
    });
    expect(bobLoaded.replayed).toBe(false);
    expect((await userCards.readMigrationReadback(bob)).accountId).toBe(bob.accountId);

    // The same snapshot identity with another plan is conflicting input, not a resume.
    const other = prepareMigration(legacyExport({ quantity: 3, accountId: bob.accountId }));
    expect(other.planDigest).not.toBe(plan.planDigest);
    const conflicting = await captureUserCardsError(
      userCards.loadMigrationPlan(bob, { plan: other, sourceDigest: other.sourceDigest }),
    );
    expect(conflicting.code).toBe('conflict');
  });

  it('refuses a blocked, tampered or mismatched plan before writing', async () => {
    const blocked = legacyExport();
    blocked.accounts[0]!.inventory.push({
      id: 'missing',
      printing_id: 'printing-absent',
      language: 'en',
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
    const blockedPlan = prepareMigration(blocked);
    expect(blockedPlan.state).toBe('blocked');

    const plan = prepareMigration(legacyExport());
    const tampered = structuredClone(plan);
    tampered.accounts[0]!.copies[0] = { ...tampered.accounts[0]!.copies[0]!, condition: 'DMG' };
    const otherTarget = prepareMigration(legacyExport({ accountId: bob.accountId }));

    for (const input of [
      { plan: blockedPlan, sourceDigest: blockedPlan.sourceDigest },
      { plan: tampered, sourceDigest: tampered.sourceDigest },
      { plan, sourceDigest: 'a'.repeat(64) },
      { plan: otherTarget, sourceDigest: otherTarget.sourceDigest },
    ]) {
      const failure = await captureUserCardsError(
        userCards.loadMigrationPlan(alice, callerInput(input)),
      );
      expect(failure.code).toBe('invalid-request');
    }
    const readback = await captureUserCardsError(userCards.readMigrationReadback(alice));
    expect(readback.code).toBe('not-found');
  });

  it('validates the plan against the target catalog instead of the preparation snapshot', async () => {
    const plan = prepareMigration(legacyExport({ finish: 'foil' }));
    await database.close();
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [{ ...boltPrinting, finishes: ['nonfoil'] }],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
    const failure = await captureUserCardsError(
      userCards.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest }),
    );
    expect(failure.code).toBe('invalid-request');

    await database.close();
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [{ ...boltPrinting, printingId: 'printing-other' }],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
    const absent = await captureUserCardsError(
      userCards.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest }),
    );
    expect(absent.code).toBe('not-found');
  });

  it('keeps the readback account-scoped and requires a completed migration', async () => {
    const plan = prepareMigration(legacyExport());
    await userCards.loadMigrationPlan(alice, { plan, sourceDigest: plan.sourceDigest });
    const absent = await captureUserCardsError(userCards.readMigrationReadback(bob));
    expect(absent.code).toBe('not-found');
    expect(plan.accounts[0]!.tags.map((tag) => tag.tagId)).toContain(
      stableId('alice', 'tag', 'box'),
    );
  });

  it('completes a plan without query-visible records and refuses a second snapshot', async () => {
    const empty = legacyExport();
    empty.accounts[0]!.inventory = [];
    empty.accounts[0]!.documents = [];
    const plan = prepareMigration(empty);
    expect(plan.state).toBe('prepared');

    const loaded = await userCards.loadMigrationPlan(alice, {
      plan,
      sourceDigest: plan.sourceDigest,
    });
    expect(loaded.totalBatches).toBe(0);
    expect(loaded.publicationPosition).toBeNull();
    expect(reconcileMigration(plan, [await userCards.readMigrationReadback(alice)])).toEqual([]);

    const later = prepareMigration(
      legacyExport({ snapshotId: 'later-snapshot', accountId: alice.accountId }),
    );
    const refused = await captureUserCardsError(
      userCards.loadMigrationPlan(alice, { plan: later, sourceDigest: later.sourceDigest }),
    );
    expect(refused.code).toBe('conflict');
  });
});
