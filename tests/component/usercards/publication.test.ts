/**
 * Component scope: the durable publication of query-visible UserCards changes
 * (docs/user-cards.md#query-surface, docs/testing.md#usercards). A write and its durable change
 * record commit or roll back together, a logical mutation is published completely, the snapshot
 * and change stream hand off without a gap, positions expire explicitly, another account's data
 * and positions never leak, and a recovered outcome reports the position it was published at.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCatalog, type Catalog } from '../../../src/catalog/index.js';
import {
  USERCARDS_PUBLICATION_LIMITS,
  USERCARDS_QUERY_SURFACE,
  createUserCards,
  createUserCardsPublication,
  type TrustedUserContext,
  type UserCards,
  type UserCardsChange,
  type UserCardsPublication,
  type UserCardsPublishedRecord,
  type UserCardsSqlTransactor,
  type UserCardsSqlValue,
} from '../../../src/usercards/index.js';
import { publishCatalog } from '../../support/catalog-database.js';
import {
  captureUserCardsError,
  createUserCardsTestDatabase,
  type UserCardsTestDatabase,
} from '../../support/usercards-database.js';

const alice: TrustedUserContext = { accountId: 'cognito-alice' };
const bob: TrustedUserContext = { accountId: 'cognito-bob' };

const lightningBolt = {
  cardId: 'oracle-lightning-bolt',
  name: 'Lightning Bolt',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

const m11Printing = {
  printingId: 'printing-m11-149-en',
  cardId: lightningBolt.cardId,
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
};

/**
 * Fails the revision marker of a publication, like a lost commit after the records were written.
 * The mutation must roll back its authoritative rows and its record changes together.
 */
function failMarkerStatements(sql: UserCardsSqlTransactor): UserCardsSqlTransactor {
  return {
    query: (statement, parameters) => sql.query(statement, parameters),
    transaction: (work) =>
      sql.transaction((statements) =>
        work({
          async query(statement: string, parameters?: Readonly<Record<string, UserCardsSqlValue>>) {
            if (
              statement.includes('usercards_private.publication') &&
              statement.includes("'revision'")
            ) {
              throw new Error('simulated publication failure');
            }
            return statements.query(statement, parameters);
          },
        }),
      ),
  };
}

/** The fields one published record carries for a declared relation, in the record's own casing. */
function declaredFields(relation: 'copies' | 'tags' | 'associations'): readonly string[] {
  return USERCARDS_QUERY_SURFACE.relations[relation].columns
    .map((column) =>
      column.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    )
    .sort();
}

describe('usercards publication', () => {
  let database: UserCardsTestDatabase;
  let catalog: Catalog;
  let userCards: UserCards;
  let publication: UserCardsPublication;

  beforeEach(async () => {
    database = await createUserCardsTestDatabase();
    await publishCatalog(database, {
      revisionId: 'revision-1',
      cards: [lightningBolt],
      printings: [m11Printing],
    });
    catalog = createCatalog({ sql: database.sql });
    userCards = createUserCards({ sql: database.sql, catalog });
    publication = createUserCardsPublication({ sql: database.sql });
  });

  afterEach(async () => {
    await database.close();
  });

  function createCopy(context: TrustedUserContext = alice) {
    return userCards.createCopies(context, {
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      quantity: 1,
    });
  }

  async function snapshot(
    accountId: string,
    pageSize?: number,
  ): Promise<{ readonly records: readonly UserCardsPublishedRecord[]; readonly position: string }> {
    const records: UserCardsPublishedRecord[] = [];
    let position: string;
    let continuation: string | undefined;
    do {
      const page = await publication.readSnapshot({
        accountId,
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(continuation === undefined ? {} : { continuation }),
      });
      records.push(...page.records);
      position = page.position;
      continuation = page.continuation ?? undefined;
    } while (continuation !== undefined);
    return { records, position };
  }

  async function changes(
    accountId: string,
    from: string,
    pageSize?: number,
  ): Promise<readonly UserCardsChange[]> {
    const read: UserCardsChange[] = [];
    let position = from;
    for (;;) {
      const page = await publication.readChanges({
        accountId,
        position,
        ...(pageSize === undefined ? {} : { pageSize }),
      });
      if (page.changes.length === 0) {
        return read;
      }
      read.push(...page.changes);
      position = page.position;
    }
  }

  function recordIdentities(
    changes: readonly UserCardsChange[],
    kind: 'copy' | 'tag' | 'association',
  ): readonly string[] {
    const identities: string[] = [];
    for (const change of changes) {
      if (change.kind === 'revision' || change.kind !== kind || change.removed) {
        continue;
      }
      const reference = change.reference;
      identities.push(
        reference.kind === 'copy'
          ? reference.copyId
          : reference.kind === 'tag'
            ? reference.tagId
            : reference.associationId,
      );
    }
    return identities;
  }

  it('publishes exactly the records the declared query surface carries', async () => {
    const created = await createCopy();
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    const { records, position } = await snapshot(alice.accountId);
    expect(BigInt(position) > 0n).toBe(true);
    const copy = records.find((record) => record.kind === 'copy')?.copy;
    const tag = records.find((record) => record.kind === 'tag')?.tag;
    const association = records.find((record) => record.kind === 'association')?.association;

    // The snapshot record carries exactly the columns the relation declares, so a replacement
    // storage that satisfies the query surface publishes the same records.
    expect(Object.keys(copy ?? {}).sort()).toEqual(declaredFields('copies'));
    expect(Object.keys(tag ?? {}).sort()).toEqual(declaredFields('tags'));
    expect(Object.keys(association ?? {}).sort()).toEqual(declaredFields('associations'));
    expect(copy).toEqual({
      copyId: created.copies[0]?.copyId,
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      owned: true,
      locationId: null,
    });
  });

  it('commits the change and its durable publication together or not at all', async () => {
    const failing = createUserCards({ sql: failMarkerStatements(database.sql), catalog });
    const outcome = await failing
      .createCopies(alice, {
        printingId: m11Printing.printingId,
        finish: 'nonfoil',
        condition: null,
        quantity: 2,
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(outcome).toBeInstanceOf(Error);

    // The interrupted mutation left neither copies nor published changes behind.
    expect(
      await database.query(
        'select count(*)::int as copies from usercards_private.copy where account_id = $1',
        [alice.accountId],
      ),
    ).toEqual([{ copies: 0 }]);
    expect(
      await database.query(
        'select count(*)::int as rows from usercards_private.publication where account_id = $1',
        [alice.accountId],
      ),
    ).toEqual([{ rows: 0 }]);
    expect(await snapshot(alice.accountId)).toEqual({ records: [], position: '0' });
    expect(await changes(alice.accountId, '0')).toEqual([]);

    // A following mutation commits both again, and its position is the one the stream reports.
    const created = await createCopy();
    expect((await snapshot(alice.accountId)).position).toBe(created.publicationPosition);
  });

  it('publishes one complete revision per mutation with the completion marker last', async () => {
    const created = await createCopy();
    const published = await changes(alice.accountId, '0', 1);
    const marker = published.at(-1);

    // The record changes of the mutation all carry its revision, and its completion marker is the
    // last position, so a consumer that applied it holds the complete mutation.
    const recordChanges = published.filter((change) => change.kind !== 'revision');
    expect(recordChanges.length).toBeGreaterThan(0);
    for (const change of recordChanges) {
      expect(change.revision).toBe(created.privateRevision);
      expect(BigInt(change.position) < BigInt(created.publicationPosition)).toBe(true);
    }
    expect(marker).toMatchObject({
      kind: 'revision',
      position: created.publicationPosition,
      revision: created.privateRevision,
      accountId: alice.accountId,
    });
    expect(recordIdentities(published, 'copy')).toEqual([created.copies[0]?.copyId as string]);
    // The first publication of an account also created its system owned tag and the copy's owned
    // membership, so the mutation published those records too.
    expect(published.some((change) => change.kind === 'tag')).toBe(true);
    expect(recordIdentities(published, 'association')).toHaveLength(1);

    // Repeated delivery preserves the meaning of every change.
    expect(await changes(alice.accountId, '0')).toEqual(published);
  });

  it('keeps pending import state out of the published records and changes', async () => {
    await userCards.stageImportEntries(alice, {
      sessionId: 'session-1',
      source: { kind: 'text', id: 'list-1' },
      entries: [{ entryId: 'line-1', printingId: m11Printing.printingId, quantity: 2 }],
    });
    const reviewed = await userCards.reviewImportEntry(alice, {
      entryId: 'line-1',
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'nonfoil',
      condition: null,
      quantity: 2,
    });
    expect(await snapshot(alice.accountId)).toEqual({ records: [], position: '0' });
    expect(await changes(alice.accountId, '0')).toEqual([]);

    // Confirming publishes the copies the import created, and nothing about the pending session.
    const confirmed = await userCards.confirmImport(alice, {
      operationId: 'operation-1',
      sessionId: 'session-1',
      entries: [{ entryId: 'line-1', expectedRevision: reviewed.entry.revision }],
    });
    const { records, position } = await snapshot(alice.accountId);
    expect(position).toBe(confirmed.publicationPosition);
    expect(records.filter((record) => record.kind === 'copy')).toHaveLength(2);
    expect(records.some((record) => record.kind === 'tag')).toBe(true);
    expect(records).toHaveLength(2 + 1 + 2);

    const published = await changes(alice.accountId, '0');
    expect(published.map((change) => change.kind).sort()).toEqual([
      'association',
      'association',
      'copy',
      'copy',
      'revision',
      'tag',
    ]);
    // The recorded outcome reports the position its copies were published at.
    const recovered = await userCards.recoverImportOperation(alice, 'operation-1');
    expect(recovered).toMatchObject({
      outcome: 'recorded',
      receipt: { publicationPosition: confirmed.publicationPosition },
    });

    // Later query-visible changes do not move the position of the recorded outcome.
    await createCopy();
    expect(await userCards.recoverImportOperation(alice, 'operation-1')).toMatchObject({
      outcome: 'recorded',
      receipt: { publicationPosition: confirmed.publicationPosition },
    });
    const replay = await userCards.confirmImport(alice, {
      operationId: 'operation-2',
      sessionId: 'session-1',
      entries: [{ entryId: 'line-1', expectedRevision: reviewed.entry.revision }],
    });
    expect(replay).toMatchObject({
      replayed: true,
      publicationPosition: confirmed.publicationPosition,
    });
  });

  it('publishes a location move as one complete mutation and an explicit removal when cleared', async () => {
    const created = await createCopy();
    const copyId = created.copies[0]?.copyId as string;
    const binder = await userCards.createTag(alice, { kind: 'location', label: 'Binder' });

    const moved = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: binder.tag.tagId,
      expectedRevision: 1,
    });
    const afterMove = await changes(alice.accountId, binder.publicationPosition);
    expect(afterMove.map((change) => change.kind)).toEqual(['copy', 'association', 'revision']);
    const movedCopy = afterMove[0];
    expect(movedCopy).toMatchObject({
      kind: 'copy',
      removed: false,
      reference: { kind: 'copy', copyId },
      record: { kind: 'copy', copy: { copyId, owned: true, locationId: binder.tag.tagId } },
    });
    expect(afterMove.at(-1)?.position).toBe(moved.publicationPosition);
    expect(afterMove[1]).toMatchObject({
      kind: 'association',
      removed: false,
      record: {
        kind: 'association',
        association: { tagId: binder.tag.tagId, targetLevel: 'copy', targetId: copyId },
      },
    });
    const locationAssociationId =
      afterMove[1]?.kind === 'association' ? afterMove[1].reference : null;
    expect(locationAssociationId).toMatchObject({ kind: 'association' });

    // Clearing the location publishes the copy without a location and an explicit removal of the
    // location membership carrying its stable identity and no record.
    const cleared = await userCards.setCopyLocation(alice, {
      copyId,
      locationTagId: null,
      expectedRevision: 2,
    });
    const afterClear = await changes(alice.accountId, moved.publicationPosition);
    expect(afterClear.map((change) => change.kind)).toEqual(['copy', 'association', 'revision']);
    expect(afterClear[0]).toMatchObject({
      kind: 'copy',
      record: { kind: 'copy', copy: { copyId, owned: true, locationId: null } },
    });
    const removal = afterClear[1];
    expect(removal).toMatchObject({
      kind: 'association',
      removed: true,
      record: null,
      reference: locationAssociationId,
    });
    expect(afterClear.at(-1)?.position).toBe(cleared.publicationPosition);
    expect(
      (await snapshot(alice.accountId)).records.filter((record) => record.kind === 'association'),
    ).toHaveLength(1);
  });

  it('publishes an association removal with its stable identity and no record', async () => {
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const association = await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });
    const removed = await userCards.removeAssociation(alice, {
      associationId: association.association.associationId,
      expectedRevision: 1,
    });
    expect(BigInt(removed.publicationPosition) > BigInt(association.publicationPosition)).toBe(
      true,
    );

    const published = await changes(alice.accountId, association.publicationPosition);
    expect(published.map((change) => change.kind)).toEqual(['association', 'revision']);
    expect(published[0]).toMatchObject({
      kind: 'association',
      removed: true,
      record: null,
      reference: { kind: 'association', associationId: association.association.associationId },
    });
    expect(
      (await snapshot(alice.accountId)).records.some(
        (record) => record.kind === 'association' && record.association.quantity === 4,
      ),
    ).toBe(false);
  });

  it('scopes every snapshot and change to its own account and fails closed on foreign positions', async () => {
    const aliceCopy = await createCopy(alice);
    const bobCopy = await createCopy(bob);
    expect(BigInt(bobCopy.publicationPosition) > BigInt(aliceCopy.publicationPosition)).toBe(true);

    const aliceSnapshot = await snapshot(alice.accountId);
    const bobSnapshot = await snapshot(bob.accountId);
    const copyIds = (records: readonly UserCardsPublishedRecord[]) =>
      records
        .filter((record) => record.kind === 'copy')
        .map((record) => (record.kind === 'copy' ? record.copy.copyId : ''));
    expect(copyIds(aliceSnapshot.records)).toEqual([aliceCopy.copies[0]?.copyId]);
    expect(copyIds(bobSnapshot.records)).toEqual([bobCopy.copies[0]?.copyId]);

    const aliceChanges = await changes(alice.accountId, '0');
    expect(aliceChanges.every((change) => change.accountId === alice.accountId)).toBe(true);
    expect(
      recordIdentities(
        aliceChanges.filter((change) => change.kind === 'copy'),
        'copy',
      ),
    ).toEqual([aliceCopy.copies[0]?.copyId]);

    // Bob's position is not part of Alice's history: reading it would skip nothing of Bob's, but
    // Alice's stream never published it, so resuming there fails instead of reporting a gap-free
    // continuation.
    const foreign = await captureUserCardsError(
      publication.readChanges({
        accountId: alice.accountId,
        position: bobCopy.publicationPosition,
      }),
    );
    expect(foreign.code).toBe('stale-continuation');

    // An unknown account has no records and no position, and never reveals another account's.
    expect(await snapshot('cognito-carol')).toEqual({ records: [], position: '0' });
    expect(await changes('cognito-carol', '0')).toEqual([]);
    expect(
      await captureUserCardsError(
        publication.readSnapshot({ accountId: 'cognito-carol', pageSize: 0 }),
      ),
    ).toMatchObject({ code: 'invalid-request' });
    expect(
      await captureUserCardsError(publication.readChanges({ accountId: '', position: '0' })),
    ).toMatchObject({ code: 'invalid-request' });
    expect(
      await captureUserCardsError(
        publication.readSnapshot({ accountId: alice.accountId, continuation: 'not-a-token' }),
      ),
    ).toMatchObject({ code: 'invalid-request' });
  });

  it('rejects a foreign position that falls inside the account’s retained range', async () => {
    const first = await createCopy(alice);
    const bobCopy = await createCopy(bob);
    const second = await createCopy(alice);
    expect(BigInt(bobCopy.publicationPosition) > BigInt(first.publicationPosition)).toBe(true);
    expect(BigInt(bobCopy.publicationPosition) < BigInt(second.publicationPosition)).toBe(true);

    // Bob's position sits between two of Alice's own positions, so a bound on Alice's retained
    // range accepts it. Alice's stream never published it, and resuming there would silently skip
    // everything Alice published before it.
    const foreign = await captureUserCardsError(
      publication.readChanges({
        accountId: alice.accountId,
        position: bobCopy.publicationPosition,
      }),
    );
    expect(foreign.code).toBe('stale-continuation');
    expect(foreign.message).toContain('read a new snapshot');

    // Alice's own earlier position still resumes her complete stream, Bob resumes from his, and
    // zero still means "before everything this account published".
    const resumed = await changes(alice.accountId, first.publicationPosition);
    expect(resumed.at(-1)?.position).toBe(second.publicationPosition);
    expect(resumed.every((change) => change.accountId === alice.accountId)).toBe(true);
    expect(
      recordIdentities(
        resumed.filter((change) => change.kind === 'copy'),
        'copy',
      ),
    ).toEqual([second.copies[0]?.copyId]);
    expect(await changes(bob.accountId, bobCopy.publicationPosition)).toEqual([]);
    expect(
      recordIdentities(
        (await changes(alice.accountId, '0')).filter((change) => change.kind === 'copy'),
        'copy',
      ),
    ).toEqual([first.copies[0]?.copyId, second.copies[0]?.copyId]);
  });

  it('pages one snapshot and hands its position to the change stream without a gap', async () => {
    await createCopy();
    const deck = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    await userCards.createAssociation(alice, {
      tagId: deck.tag.tagId,
      targetLevel: 'card',
      targetId: lightningBolt.cardId,
      quantity: 4,
    });

    const first = await publication.readSnapshot({ accountId: alice.accountId, pageSize: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.continuation).not.toBeNull();
    const second = await publication.readSnapshot({
      accountId: alice.accountId,
      pageSize: 2,
      continuation: first.continuation as string,
    });
    expect(second.position).toBe(first.position);
    expect(second.records).toHaveLength(2);
    expect(second.continuation).not.toBeNull();
    const third = await publication.readSnapshot({
      accountId: alice.accountId,
      pageSize: 2,
      continuation: second.continuation as string,
    });
    expect(third.records).toHaveLength(1);
    expect(third.continuation).toBeNull();
    const paged = [...first.records, ...second.records, ...third.records];
    expect(paged).toEqual((await snapshot(alice.accountId)).records);

    // A mutation after the snapshot follows its position; resuming there delivers it completely.
    const created = await createCopy();
    const next = await changes(alice.accountId, third.position);
    expect(next.map((change) => change.kind)).toEqual(['copy', 'association', 'revision']);
    expect(next.at(-1)?.position).toBe(created.publicationPosition);
    expect(next.at(-1)).toMatchObject({ kind: 'revision', revision: created.privateRevision });

    // The pages of the older position cannot be mixed with the newer publication.
    const stale = await captureUserCardsError(
      publication.readSnapshot({
        accountId: alice.accountId,
        pageSize: 2,
        continuation: first.continuation as string,
      }),
    );
    expect(stale.code).toBe('stale-continuation');
    expect((await snapshot(alice.accountId)).position).toBe(created.publicationPosition);
  });

  it('expires positions older than the retained history and requires a new snapshot', async () => {
    const retained = USERCARDS_PUBLICATION_LIMITS.retainedRevisions;
    const published: string[] = [];
    for (let index = 0; index < retained + 1; index += 1) {
      published.push((await createCopy()).publicationPosition);
    }
    const oldest = published[0] as string;
    const boundary = published[1] as string;

    // Retention dropped everything before the boundary; a resume from the oldest position would
    // silently skip the changes of the first publication.
    const expired = await captureUserCardsError(
      publication.readChanges({ accountId: alice.accountId, position: oldest }),
    );
    expect(expired.code).toBe('stale-continuation');
    expect(expired.message).toContain('read a new snapshot');

    const resumed = await changes(alice.accountId, boundary);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.every((change) => BigInt(change.position) > BigInt(boundary))).toBe(true);

    // A new snapshot always works and reports the newest position.
    const current = await snapshot(alice.accountId);
    expect(current.position).toBe(published.at(-1));
    expect(await changes(alice.accountId, current.position)).toEqual([]);
  });

  it('reports the publication position of every query-visible mutation', async () => {
    const created = await createCopy();
    const tag = await userCards.createTag(alice, { kind: 'deck', label: 'Burn' });
    const association = await userCards.createAssociation(alice, {
      tagId: tag.tag.tagId,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 2,
    });
    const corrected = await userCards.correctCopy(alice, {
      copyId: created.copies[0]?.copyId as string,
      expectedRevision: 1,
      printingId: m11Printing.printingId,
      finish: 'foil',
      condition: 'LP',
    });
    const renamed = await userCards.renameTag(alice, {
      tagId: tag.tag.tagId,
      expectedRevision: 1,
      label: 'Burn deck',
    });
    const changed = await userCards.changeAssociation(alice, {
      associationId: association.association.associationId,
      expectedRevision: 1,
      targetLevel: 'printing',
      targetId: m11Printing.printingId,
      quantity: 4,
    });

    const positions = [
      created.publicationPosition,
      tag.publicationPosition,
      association.publicationPosition,
      corrected.publicationPosition,
      renamed.publicationPosition,
      changed.publicationPosition,
    ];
    // Every mutation published its own revision, and the reported positions only grow.
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((left, right) => Number(left) - Number(right))).toEqual(positions);
    for (const position of positions) {
      const change = (await changes(alice.accountId, '0')).find(
        (candidate) => candidate.kind === 'revision' && candidate.position === position,
      );
      expect(change).toBeDefined();
    }
  });
});
