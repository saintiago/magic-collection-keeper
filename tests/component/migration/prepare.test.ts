import { describe, expect, it } from 'vitest';
import { USERCARDS_LIMITS } from '../../../src/usercards/index.js';
import {
  bundle,
  canonical,
  digest,
  legacyRevision,
  projectLegacy,
  stableId,
} from '../../../scripts/migration/legacy.js';
import { prepareMigration, verifyPlan } from '../../../scripts/migration/prepare.js';
import {
  reconcileMigration,
  type MigrationReadback,
} from '../../../scripts/migration/reconcile.js';

function fixture() {
  return bundle.parse({
    format: 'keeper-legacy-export-v1',
    legacyRevision,
    snapshotId: 'synthetic-snapshot',
    catalog: [
      {
        printingId: 'bolt',
        cardId: 'oracle-bolt',
        language: 'en',
        finishes: ['nonfoil'],
        paper: true,
      },
    ],
    accounts: [
      {
        owner: 'alice',
        accountId: 'alice',
        inventory: [
          {
            id: 'native',
            printing_id: 'bolt',
            language: 'en',
            finish: 'nonfoil',
            condition: 'NM',
            quantity: 3,
          },
        ],
        documents: [],
        operations: [{ id: 'old-operation', fingerprint: 'original-fingerprint' }],
      },
    ],
  });
}
function doc(space: string, id: string, value: Record<string, unknown>) {
  return { space, id, version: 1, value };
}
function draft(id: string) {
  return {
    id,
    state: 'pending',
    provider: 'reviewed-capture',
    source_id: `capture:${id}`,
    rows: [
      {
        id: 'row',
        printing_id: null,
        finish: 'nonfoil',
        condition: 'UNK',
        quantity: 2,
        original: { name: 'Unresolved card' },
      },
    ],
  };
}

describe('offline migration preparation', () => {
  it.each([
    { finish: 'foil' },
    { printing_id: null, finish: 'foil' },
    { printing_id: '', finish: 'foil' },
    { printing_id: 123, finish: 'foil' },
    { printing_id: 'source-printing' },
    { printing_id: 'source-printing', finish: 'unknown' },
  ])('blocks Moxfield drafts with insufficient original replay evidence: %j', (original) => {
    const raw = fixture();
    const pending = draft('moxfield-draft');
    raw.accounts[0]!.documents.push(
      doc('import-drafts', pending.id, {
        ...pending,
        provider: 'moxfield',
        rows: [
          {
            ...pending.rows[0],
            printing_id: 'bolt',
            original: { name: 'Lightning Bolt', ...original },
          },
        ],
      }),
    );
    const plan = prepareMigration(raw);
    expect(plan.state).toBe('blocked');
    expect(plan.issues).toContainEqual(
      expect.objectContaining({ code: 'source-replay-compatibility' }),
    );
    expect(plan.archive).toEqual(raw);
    expect(() => verifyPlan(plan)).toThrow('unresolved blockers');
  });

  it('expands ownership, keeps unknown condition explicit and never mutates its input', () => {
    const raw = fixture();
    raw.accounts[0]!.inventory[0]!.condition = 'UNK';
    const before = canonical(raw);
    const plan = prepareMigration(raw);
    expect(plan.state).toBe('prepared');
    expect(plan.accounts[0]!.copies).toHaveLength(3);
    expect(new Set(plan.accounts[0]!.copies.map((c) => c.copyId)).size).toBe(3);
    expect(plan.accounts[0]!.copies.every((c) => c.condition === null)).toBe(true);
    expect(canonical(raw)).toBe(before);
    expect(plan.archive).toEqual(raw);
    expect(prepareMigration(raw)).toEqual(plan);
    expect(() => verifyPlan(plan)).not.toThrow();
  });

  it('uses effective imported ownership, retained lots and manual total overrides exactly once', () => {
    const raw = fixture();
    raw.accounts[0]!.inventory[0]!.condition = 'UNK';
    const groupId = 'group:' + digest('bolt|en|nonfoil|UNK');
    raw.accounts[0]!.documents.push(
      doc('cards', 'bolt', { id: 'bolt', lang: 'en' }),
      doc('tags', 'deck', {
        id: 'deck',
        type: 'location',
        kind: 'deck',
        label: 'My physical deck',
      }),
      doc('decks', 'source', {
        source_id: 'source',
        provider: 'moxfield',
        tag_id: 'deck',
        fingerprint: 'keep-me',
        lots: [
          {
            line_id: 'line',
            printing_id: 'bolt',
            finish: 'nonfoil',
            owned_quantity: 5,
            allocated_quantity: 2,
          },
        ],
      }),
      doc('totals', groupId, { delta: -1 }),
    );
    const plan = prepareMigration(raw),
      a = plan.accounts[0]!;
    expect(plan.issues).toEqual([]);
    expect(a.expected.ownedCopies).toBe(7); // native 3 + lot 5 - override 1, not 3+5+2.
    expect(a.copies).toHaveLength(7);
    expect(a.tags[0]!.kind).toBe('deck');
    expect(a.associations).toHaveLength(1);
    expect(a.groups[0]!.sources).toEqual(['source']);
    expect(a.associations[0]).toMatchObject({
      targetLevel: 'printing',
      targetId: 'bolt',
      quantity: 2,
    });
  });

  it('keeps deck quantities independent of ownership and combines one printing across conditions', () => {
    const raw = fixture();
    raw.accounts[0]!.inventory[0]!.quantity = 1;
    raw.accounts[0]!.inventory.push({
      id: 'second',
      printing_id: 'bolt',
      language: 'en',
      finish: 'nonfoil',
      condition: 'LP',
      quantity: 1,
    });
    for (const id of ['deck-a', 'deck-b'])
      raw.accounts[0]!.documents.push(
        doc('tags', id, { id, type: 'location', kind: 'deck', label: id }),
      );
    raw.accounts[0]!.documents.push(
      doc('assignments', 'native', {
        locations_override: true,
        locations: [
          { tag_id: 'deck-a', quantity: 4 },
          { tag_id: 'deck-b', quantity: 4 },
        ],
      }),
      doc('assignments', 'second', {
        locations_override: true,
        locations: [{ tag_id: 'deck-a', quantity: 2 }],
      }),
    );
    const plan = prepareMigration(raw),
      a = plan.accounts[0]!;
    expect(plan.state).toBe('prepared');
    expect(a.copies).toHaveLength(2);
    expect(a.expected.ownedCopies).toBe(2);
    expect(a.associations.filter((r) => r.targetLevel === 'copy')).toHaveLength(0);
    expect(a.associations.map((r) => r.quantity).sort()).toEqual([4, 6]);
    expect(a.associations.every((r) => r.targetId === 'bolt' && r.targetLevel === 'printing')).toBe(
      true,
    );
    expect(() => verifyPlan(plan)).not.toThrow();
  });

  it('preserves assignment overrides while retaining later additive source allocations', () => {
    const raw = fixture();
    raw.accounts[0]!.inventory = [];
    const groupId = 'group:' + digest('bolt|en|nonfoil|UNK');
    raw.accounts[0]!.documents.push(
      doc('cards', 'bolt', { id: 'bolt', lang: 'en' }),
      doc('tags', 'box', { id: 'box', type: 'location', kind: 'box', label: 'Box' }),
      doc('tags', 'role', { id: 'role', type: 'role', kind: 'role', label: 'Removal' }),
      doc('assignments', groupId, {
        locations_override: true,
        locations: [],
        tag_ids: [],
        source_ids: ['old'],
      }),
    );
    for (const id of ['old', 'new'])
      raw.accounts[0]!.documents.push(
        doc('decks', id, {
          source_id: id,
          provider: 'reviewed-capture',
          review: { additive_default: true },
          lots: [
            {
              line_id: 'line',
              printing_id: 'bolt',
              finish: 'nonfoil',
              owned_quantity: 2,
              allocated_quantity: 2,
              locations: [{ tag_id: 'box', quantity: 2 }],
              tag_ids: ['role'],
            },
          ],
        }),
      );
    const group = projectLegacy(raw.accounts[0]!)[0]!;
    expect(group.quantity).toBe(4);
    expect(group.locations).toEqual([{ tag_id: 'box', quantity: 2 }]);
    expect(group.tagIds).toEqual(['role']);
    const a = prepareMigration(raw).accounts[0]!;
    expect(a.associations).toHaveLength(6); // two physical locations and four aggregate classifications.
  });

  it('blocks over-allocation and incompatible printing instead of inventing copies or remapping', () => {
    const raw = fixture();
    raw.accounts[0]!.documents.push(
      doc('tags', 'box', { id: 'box', type: 'location', kind: 'box', label: 'Box' }),
      doc('assignments', 'native', {
        locations_override: true,
        locations: [{ tag_id: 'box', quantity: 4 }],
      }),
    );
    raw.catalog[0]!.language = 'ja';
    const plan = prepareMigration(raw);
    expect(plan.state).toBe('blocked');
    expect(plan.accounts[0]!.copies).toEqual([]);
    expect(plan.accounts[0]!.expected.ownedCopies).toBe(3);
    expect(plan.issues.map((i) => i.code)).toEqual(['printing-mismatch', 'location-shortfall']);
    expect(() => verifyPlan(plan)).toThrow('blockers');
  });

  it('keeps equal-content imports distinct, pending and excluded from ownership', () => {
    const raw = fixture();
    raw.accounts[0]!.documents.push(
      doc('import-drafts', 'capture:a', draft('a')),
      doc('import-drafts', 'capture:b', draft('b')),
    );
    const plan = prepareMigration(raw),
      a = plan.accounts[0]!;
    expect(plan.state).toBe('prepared');
    expect(a.sessions).toHaveLength(2);
    expect(a.pending).toHaveLength(2);
    expect(a.pending[0]!.sessionId).not.toBe(a.pending[1]!.sessionId);
    expect(a.expected).toEqual({ ownedCopies: 3, pendingCopies: 4 });
    expect(a.pending.every((e) => e.state === 'pending' && e.printingId === null)).toBe(true);
  });

  it('retains scan batch order without counting the header or tombstones as pending', () => {
    const raw = fixture();
    raw.accounts[0]!.documents.push(
      doc('import-drafts', 'scan:session', {
        provider: 'scan-session',
        id: 'session',
        state: 'pending',
        batches: 2,
        accepted: 2,
        pending_batches: 2,
        pending_copies: 4,
      }),
      doc('scan-batch-index', 'session:000000000001', { batch_id: 'a' }),
      doc('scan-batch-index', 'session:000000000002', { batch_id: 'b' }),
      doc('scan-capture-index', 'row-a', { session_id: 'session', batch_id: 'a' }),
      doc('scan-capture-index', 'row-b', { session_id: 'session', batch_id: 'b' }),
      doc('scan-drafts', 'b', {
        ...draft('b'),
        rows: draft('b').rows.map((r) => ({ ...r, id: 'row-b' })),
        scan_session: { id: 'session', index: 2 },
      }),
      doc('scan-drafts', 'a', {
        ...draft('a'),
        rows: draft('a').rows.map((r) => ({ ...r, id: 'row-a' })),
        scan_session: { id: 'session', index: 1 },
      }),
      doc('import-drafts', 'active', { state: 'empty' }),
      doc('import-receipts', 'closed', { added_at: '2026-01-01' }),
    );
    const plan = prepareMigration(raw),
      a = plan.accounts[0]!;
    expect(plan.state).toBe('prepared');
    expect(a.sessions).toHaveLength(1);
    expect(a.pending.map((e) => [e.legacyDocument, e.position])).toEqual([
      ['scan-drafts/a', 1],
      ['scan-drafts/b', 2],
    ]);
    const missingCapture = structuredClone(raw);
    missingCapture.accounts[0]!.documents = missingCapture.accounts[0]!.documents.filter(
      (d) => d.id !== 'row-a',
    );
    expect(prepareMigration(missingCapture).state).toBe('blocked');
    raw.accounts[0]!.documents = raw.accounts[0]!.documents.filter((d) => d.id !== 'b');
    expect(prepareMigration(raw).state).toBe('blocked');
  });

  it('checks replay indexes even after a scan batch is closed and keeps draft-edit receipts', () => {
    const raw = fixture();
    raw.accounts[0]!.documents.push(
      doc('import-drafts', 'scan:session', {
        provider: 'scan-session',
        id: 'session',
        state: 'empty',
        batches: 1,
        accepted: 1,
        pending_batches: 0,
        pending_copies: 0,
      }),
      doc('scan-drafts', 'batch', { state: 'empty', scan_session: { id: 'session', index: 1 } }),
      doc('scan-batch-index', 'session:000000000001', { batch_id: 'batch' }),
      doc('scan-capture-index', 'capture', { session_id: 'session', batch_id: 'batch' }),
      doc('draft-tag-actions', 'edit', {
        input: { operation_id: 'edit', draft_id: 'closed' },
        created_at: '2026-01-01T00:00:00Z',
      }),
    );
    const plan = prepareMigration(raw);
    expect(plan.state).toBe('prepared');
    expect(plan.accounts[0]!.pending).toHaveLength(0);
    expect(plan.archive).toEqual(raw);
    const invalidVariants = [
      [
        ...raw.accounts[0]!.documents,
        doc('scan-batch-index', 'session:000000000002', { batch_id: 'batch' }),
      ],
      [
        ...raw.accounts[0]!.documents,
        doc('scan-batch-index', 'other:000000000001', { batch_id: 'batch' }),
      ],
      raw.accounts[0]!.documents.map((d) =>
        d.space === 'scan-capture-index'
          ? { ...d, value: { session_id: 'session', batch_id: 'absent' } }
          : d,
      ),
      raw.accounts[0]!.documents.map((d) =>
        d.space === 'scan-capture-index'
          ? { ...d, value: { session_id: 'other', batch_id: 'batch' } }
          : d,
      ),
    ];
    for (const documents of invalidVariants) {
      expect(
        prepareMigration({ ...raw, accounts: [{ ...raw.accounts[0]!, documents }] }).state,
      ).toBe('blocked');
    }
  });

  it('preserves an aggregated deck quantity the current target cannot yet accept', () => {
    const raw = fixture();
    // The legacy aggregate stays above the target's product bound, whatever that bound is: it is
    // reported as a blocker instead of being truncated or split.
    const perAssignment = Math.ceil((USERCARDS_LIMITS.maxAssociationQuantity + 1) / 2);
    const aggregate = perAssignment * 2;
    raw.catalog[0]!.finishes.push('foil');
    raw.accounts[0]!.inventory.push({
      id: 'foil',
      printing_id: 'bolt',
      language: 'en',
      finish: 'foil',
      condition: 'NM',
      quantity: 1,
    });
    raw.accounts[0]!.documents.push(
      doc('tags', 'deck', { id: 'deck', type: 'location', kind: 'deck', label: 'Deck' }),
      ...['native', 'foil'].map((id) =>
        doc('assignments', id, {
          locations_override: true,
          locations: [{ tag_id: 'deck', quantity: perAssignment }],
        }),
      ),
    );
    const plan = prepareMigration(raw);
    expect(plan.state).toBe('blocked');
    expect(plan.issues.map((i) => i.code)).toEqual(['deck-quantity-compatibility']);
    expect(plan.accounts[0]!.associations[0]).toMatchObject({
      targetLevel: 'printing',
      quantity: aggregate,
    });
    expect(plan.accounts[0]!.copies).toHaveLength(4);
    expect(plan.archive).toEqual(raw);
  });

  it('blocks pending assignments that the new model cannot represent', () => {
    const raw = fixture(),
      pending = draft('a');
    raw.accounts[0]!.documents.push(
      doc('import-drafts', 'a', {
        ...pending,
        rows: pending.rows.map((r) => ({ ...r, tag_ids: ['tag'] })),
      }),
    );
    const plan = prepareMigration(raw);
    expect(plan.issues.map((i) => i.code)).toContain('pending-assignment');
    expect(plan.accounts[0]!.pending).toHaveLength(1);
    expect(plan.archive).toEqual(raw);
  });

  it('rejects duplicate keys, unknown spaces, negative effective totals and orphan edits', () => {
    for (const extra of [
      [doc('totals', 'native', { delta: -99 })],
      [doc('totals', 'missing', { delta: 1 })],
      [doc('new-space', 'x', {})],
      [doc('cards', 'x', {}), doc('cards', 'x', {})],
    ]) {
      const raw = fixture();
      raw.accounts[0]!.documents.push(...extra);
      expect(prepareMigration(raw).state).toBe('blocked');
    }
  });

  it('binds deterministic identities to owners while preserving replay records unchanged', () => {
    const raw = fixture();
    raw.accounts.push({ ...structuredClone(raw.accounts[0]!), owner: 'bob', accountId: 'bob' });
    const p = prepareMigration(raw);
    expect(p.accounts[0]!.copies[0]!.copyId).not.toBe(p.accounts[1]!.copies[0]!.copyId);
    const revised = fixture();
    revised.snapshotId = 'later-export';
    expect(prepareMigration(revised).accounts[0]!.copies).toEqual(p.accounts[0]!.copies);
    expect(p.accounts[0]!.copies[0]!.copyId).toBe(stableId('alice', 'copy', 'native', '1'));
    expect(p.sourceDigest).toBe(digest(canonical(raw)));
  });

  it('rejects plan tampering, even if someone recomputes only the outer digest', () => {
    const plan = prepareMigration(fixture());
    plan.accounts[0]!.copies[0] = { ...plan.accounts[0]!.copies[0]!, condition: 'DMG' };
    expect(() => verifyPlan(plan)).toThrow('changed');
    const content = { ...plan } as Partial<typeof plan>;
    delete content.planDigest;
    plan.planDigest = digest(canonical(content));
    expect(() => verifyPlan(plan)).toThrow('differs');
  });

  it('reconciles exact identities and attributes, not only equal totals', () => {
    const plan = prepareMigration(fixture()),
      a = plan.accounts[0]!;
    const actual: MigrationReadback = {
      ...a,
      archiveDigest: plan.sourceDigest,
      ownedCopyIds: a.copies.map((c) => c.copyId),
      copies: a.copies.map(({ copyId, printingId, finish, condition, revision }) => ({
        copyId,
        printingId,
        finish,
        condition,
        revision,
      })),
    };
    expect(reconcileMigration(plan, [actual])).toEqual([]);
    const wrong = {
      ...actual,
      copies: actual.copies.map((c, i) => (i === 0 ? { ...c, condition: 'DMG' as const } : c)),
    };
    expect(reconcileMigration(plan, [wrong])).toEqual(['alice: copies mismatch']);
    expect(reconcileMigration(plan, [])).toEqual(['alice: missing account']);
    expect(reconcileMigration(plan, [{ ...actual, ownedCopyIds: [] }])).toEqual([
      'alice: ownership mismatch',
    ]);
  });
});
