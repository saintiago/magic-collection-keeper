/** Pure preparation of a migration plan; never connects to a store or performs a write. */
import { z } from 'zod';
import type {
  Association,
  ImportEntry,
  ImportSession,
  PhysicalCopy,
  Tag,
} from '../../src/usercards/index.js';
import { USERCARDS_LIMITS } from '../../src/usercards/index.js';
import {
  allocation,
  bundle,
  canonical,
  condition,
  digest,
  finish,
  projectLegacy,
  records,
  stableId,
  tag,
  type LegacyAccount,
  type LegacyBundle,
} from './legacy.js';

const pendingRow = z
  .object({
    id: z.string().min(1),
    quantity: z.number().int().positive(),
    printing_id: z.string().nullable(),
    finish: finish.nullable(),
    condition: condition.optional(),
    tag_ids: z.array(z.string()).default([]),
    locations: z.array(allocation).default([]),
    in_deck: z.boolean().optional(),
    original: z.record(z.string(), z.unknown()),
    recognition_candidates: z
      .array(
        z
          .object({ printing_id: z.string(), provider: z.string(), evidence: z.string() })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const pendingDraft = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1).max(USERCARDS_LIMITS.maxIdentifierLength),
    source_id: z.string().min(1).max(USERCARDS_LIMITS.maxIdentifierLength),
    url: z.string().max(USERCARDS_LIMITS.maxSourceReferenceLength).optional(),
    rows: z.array(pendingRow).min(1),
    scan_session: z.object({ id: z.string(), index: z.number().int().positive() }).optional(),
  })
  .passthrough();
const knownSpaces = new Set([
  'cards',
  'tags',
  'assignments',
  'totals',
  'decks',
  'import-drafts',
  'scan-drafts',
  'import-stages',
  'import-receipts',
  'tag-actions',
  'draft-tag-actions',
  'scan-batch-index',
  'scan-capture-index',
]);

export interface MigrationIssue {
  accountId: string;
  reference: string;
  code: string;
  message: string;
}
export interface PreparedAccount {
  accountId: string;
  copies: (PhysicalCopy & { legacyGroupId: string; ordinal: number })[];
  tags: (Tag & { legacyTagId: string })[];
  associations: Association[];
  sessions: ImportSession[];
  pending: (ImportEntry & { legacyDocument: string; legacyRowId: string })[];
  groups: ReturnType<typeof projectLegacy>;
  expected: { ownedCopies: number; pendingCopies: number };
}
export interface MigrationPlan {
  format: 'keeper-migration-plan-v1';
  state: 'prepared' | 'blocked';
  snapshotId: string;
  sourceDigest: string;
  planDigest: string;
  issues: MigrationIssue[];
  accounts: PreparedAccount[];
  /** Exact input, including source lots, fingerprints, receipts, timestamps and replay evidence. */
  archive: unknown;
}

/** IDs depend on source identities, not names, array order, timestamps or the run identifier. */
export function prepareMigration(raw: unknown): MigrationPlan {
  const input = bundle.parse(raw);
  const issues: MigrationIssue[] = [];
  const accounts: PreparedAccount[] = [];
  const owners = new Set<string>(),
    targets = new Set<string>();
  const catalog = new Map(input.catalog.map((p) => [p.printingId, p]));
  if (catalog.size !== input.catalog.length)
    throw new Error('Duplicate printing in target catalog snapshot.');
  for (const source of [...input.accounts].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0,
  )) {
    const issue = (reference: string, code: string, message: string) => {
      issues.push({ accountId: source.accountId, reference, code, message });
    };
    if (owners.has(source.owner) || targets.has(source.accountId)) {
      issue(
        'account',
        'duplicate-account',
        'Each source owner and target account must occur exactly once.',
      );
      continue;
    }
    owners.add(source.owner);
    targets.add(source.accountId);
    const prepared: PreparedAccount = {
      accountId: source.accountId,
      copies: [],
      tags: [],
      associations: [],
      sessions: [],
      pending: [],
      groups: [],
      expected: { ownedCopies: 0, pendingCopies: 0 },
    };
    accounts.push(prepared);
    try {
      validateSource(source);
      validateScanIndexes(source);
      for (const doc of source.documents)
        if (!knownSpaces.has(doc.space)) {
          issue(
            `${doc.space}/${doc.id}`,
            'unknown-space',
            'Preserved in archive; its meaning must be mapped before rehearsal.',
          );
        }
      const tags = new Map(
        records(source, 'tags').map((doc) => {
          const t = tag.parse(doc.value);
          if (t.id !== doc.id) throw new Error('Tag identity differs from its document key.');
          if (t.label.toLowerCase().startsWith('system:'))
            throw new Error('Reserved system tag needs explicit reconciliation.');
          const supported = t.type === 'location' ? ['deck', 'binder', 'box', 'other'] : [t.type];
          if (!supported.includes(t.kind)) throw new Error('Unknown legacy tag kind.');
          const tagId = stableId(source.owner, 'tag', t.id);
          prepared.tags.push({
            tagId,
            legacyTagId: t.id,
            kind: t.type === 'location' ? (t.kind === 'deck' ? 'deck' : 'location') : 'other',
            label: t.label,
            system: false,
            revision: 1,
          });
          return [t.id, { ...t, tagId }];
        }),
      );
      prepared.tags.sort((a, b) => a.tagId.localeCompare(b.tagId));
      prepared.groups = projectLegacy(source);
      const deckAssociations = new Map<string, Association>();
      for (const group of prepared.groups) {
        prepared.expected.ownedCopies += group.quantity;
        const before = issues.length;
        const printing = catalog.get(group.printingId);
        if (
          printing === undefined ||
          printing.language !== group.language ||
          !printing.paper ||
          !printing.finishes.includes(group.finish)
        ) {
          issue(
            group.id,
            'printing-mismatch',
            'Target catalog must contain this exact paper printing, language and finish.',
          );
        }
        const locations = group.locations
          .filter((l) => tags.get(l.tag_id)?.kind !== 'deck')
          .toSorted((a, b) => a.tag_id.localeCompare(b.tag_id));
        if (locations.reduce((n, l) => n + l.quantity, 0) > group.quantity) {
          issue(
            group.id,
            'location-shortfall',
            'Physical location quantities exceed ownership. Deck requirements are independent; do not invent copies or choose a physical location automatically.',
          );
        }
        for (const l of group.locations)
          if (tags.get(l.tag_id)?.type !== 'location') {
            issue(
              group.id,
              'missing-location',
              'Allocation does not reference an available location tag.',
            );
          }
        for (const id of group.tagIds)
          if (!['role', 'category'].includes(tags.get(id)?.type ?? '')) {
            issue(
              group.id,
              'missing-tag',
              'Classification does not reference an available role/category tag.',
            );
          }
        if (issues.length !== before) continue;
        for (const allocation of group.locations.filter(
          (l) => tags.get(l.tag_id)?.kind === 'deck',
        )) {
          const tagId = tags.get(allocation.tag_id)!.tagId;
          const associationId = stableId(source.accountId, tagId, 'printing', group.printingId);
          const previous = deckAssociations.get(associationId);
          const quantity = (previous?.quantity ?? 0) + allocation.quantity;
          if (!Number.isSafeInteger(quantity)) throw new Error('Invalid effective deck quantity.');
          deckAssociations.set(associationId, {
            associationId,
            tagId,
            targetLevel: 'printing',
            targetId: group.printingId,
            quantity,
            revision: 1,
          });
        }
        // Copies in a legacy aggregate have no individual identity. Ordinals carry no historical claim.
        let locationIndex = 0,
          locationUsed = 0;
        for (let ordinal = 1; ordinal <= group.quantity; ordinal++) {
          const copyId = stableId(source.owner, 'copy', group.id, String(ordinal));
          prepared.copies.push({
            copyId,
            printingId: group.printingId,
            finish: group.finish,
            condition: group.condition === 'UNK' ? null : group.condition,
            revision: 1,
            legacyGroupId: group.id,
            ordinal,
          });
          const location = locations[locationIndex];
          if (location !== undefined) {
            addMembership(prepared, tags.get(location.tag_id)!.tagId, copyId);
            if (++locationUsed === location.quantity) {
              locationIndex++;
              locationUsed = 0;
            }
          }
          for (const id of group.tagIds) addMembership(prepared, tags.get(id)!.tagId, copyId);
        }
      }
      for (const association of deckAssociations.values()) {
        if (association.quantity! > USERCARDS_LIMITS.maxAssociationQuantity) {
          issue(
            association.associationId,
            'deck-quantity-compatibility',
            'Preserved deck quantity exceeds the current target public contract. Update target support before loading; do not truncate or split the deck requirement.',
          );
        }
      }
      prepared.associations.push(
        ...[...deckAssociations.values()].sort((a, b) =>
          a.associationId.localeCompare(b.associationId),
        ),
      );
      preparePending(source, prepared, catalog, issue);
    } catch (error) {
      // Never copy source values or Zod's received values into diagnostics.
      issue(
        'source',
        'invalid-source',
        error instanceof z.ZodError
          ? 'Legacy record shape is invalid; inspect the private archive.'
          : error instanceof Error
            ? error.message
            : 'Invalid legacy input.',
      );
    }
  }
  const content = {
    format: 'keeper-migration-plan-v1' as const,
    state: issues.length === 0 ? ('prepared' as const) : ('blocked' as const),
    snapshotId: input.snapshotId,
    sourceDigest: digest(canonical(raw)),
    issues,
    accounts,
    archive: raw,
  };
  return { ...content, planDigest: digest(canonical(content)) };
}

function addMembership(target: PreparedAccount, tagId: string, copyId: string): void {
  target.associations.push({
    associationId: stableId(target.accountId, tagId, copyId),
    tagId,
    targetLevel: 'copy',
    targetId: copyId,
    quantity: null,
    revision: 1,
  });
}
function validateSource(source: LegacyAccount): void {
  const docs = new Set<string>();
  for (const d of source.documents) {
    const key = JSON.stringify([d.space, d.id]);
    if (docs.has(key)) throw new Error('Duplicate document identity.');
    docs.add(key);
  }
  const ids = new Set<string>(),
    variants = new Set<string>();
  for (const r of source.inventory) {
    const variant = JSON.stringify([r.printing_id, r.language, r.finish, r.condition]);
    if (ids.has(String(r.id)) || variants.has(variant))
      throw new Error('Duplicate native inventory identity or variant.');
    ids.add(String(r.id));
    variants.add(variant);
  }
}

function preparePending(
  source: LegacyAccount,
  target: PreparedAccount,
  catalog: Map<string, LegacyBundle['catalog'][number]>,
  issue: (ref: string, code: string, message: string) => void,
): void {
  const sessions = new Map<string, { -readonly [K in keyof ImportSession]: ImportSession[K] }>();
  const seenEntries = new Set<string>(),
    seenDrafts = new Set<string>();
  const docs = source.documents
    .filter((d) => ['import-drafts', 'scan-drafts'].includes(d.space))
    .sort((a, b) => {
      const ai = (a.value.scan_session as { index?: number } | undefined)?.index ?? 0;
      const bi = (b.value.scan_session as { index?: number } | undefined)?.index ?? 0;
      return ai - bi || a.id.localeCompare(b.id);
    });
  for (const doc of docs) {
    if (doc.value.provider === 'scan-session') continue; // Header is an index, never a second batch.
    if (doc.value.state === 'empty') continue; // Tombstone and receipt remain in the archive.
    if (doc.value.state !== 'pending') {
      issue(
        `${doc.space}/${doc.id}`,
        'unknown-draft-state',
        'Unknown persisted import lifecycle state.',
      );
      continue;
    }
    const draft = pendingDraft.parse(doc.value);
    if (seenDrafts.has(draft.id)) throw new Error('Duplicate active draft identity.');
    seenDrafts.add(draft.id);
    if (records(source, 'import-receipts').some((r) => r.id === draft.id)) {
      issue(
        doc.id,
        'confirmed-pending',
        'A confirmed receipt and active pending draft share an identity.',
      );
    }
    if (
      draft.scan_session &&
      !records(source, 'import-drafts').some(
        (r) => r.id === `scan:${draft.scan_session!.id}` && r.value.provider === 'scan-session',
      )
    ) {
      issue(doc.id, 'missing-scan-header', 'Scan batch has no session header.');
    }
    const sessionKey = draft.scan_session?.id ?? draft.id;
    const sessionId = stableId(source.owner, 'import', sessionKey);
    let session = sessions.get(sessionId);
    if (session === undefined) {
      session = {
        sessionId,
        sourceKind: draft.scan_session ? 'legacy-scan' : draft.provider,
        sourceId: draft.scan_session?.id ?? draft.source_id,
        sourceReference: draft.url || null,
        state: 'pending',
        pendingEntries: 0,
        confirmedEntries: 0,
        discardedEntries: 0,
        revision: 1,
      };
      sessions.set(sessionId, session);
    }
    for (const row of draft.rows) {
      const entryId = stableId(source.owner, 'entry', draft.id, row.id);
      if (seenEntries.has(entryId)) throw new Error('Duplicate pending entry identity.');
      seenEntries.add(entryId);
      target.expected.pendingCopies += row.quantity;
      if (row.locations.length || row.tag_ids.length || row.in_deck === true) {
        issue(
          row.id,
          'pending-assignment',
          'Pending tag/location intentions have no current target entry field. Preserve them and resolve before applying.',
        );
      }
      if (row.quantity > USERCARDS_LIMITS.maxCreateQuantity) {
        issue(
          row.id,
          'pending-quantity',
          'Pending quantity exceeds the target confirmation contract; do not truncate or split silently.',
        );
      }
      if (row.printing_id !== null) {
        const printing = catalog.get(row.printing_id);
        if (
          !printing ||
          !printing.paper ||
          (row.finish !== null && !printing.finishes.includes(row.finish))
        ) {
          issue(
            row.id,
            'pending-printing',
            'Resolved pending printing is absent or incompatible in the target catalog.',
          );
        }
      }
      if (row.recognition_candidates.some((c) => !catalog.has(c.printing_id))) {
        issue(
          row.id,
          'candidate-printing',
          'A retained candidate is unavailable in the target catalog.',
        );
      }
      if (
        row.recognition_candidates.length > USERCARDS_LIMITS.maxImportCandidates ||
        row.recognition_candidates.some((c) =>
          [c.printing_id, c.provider, c.evidence].some(
            (v) => !v.length || v.length > USERCARDS_LIMITS.maxIdentifierLength,
          ),
        )
      ) {
        issue(
          row.id,
          'candidate-contract',
          'Retained candidates exceed the target public contract; do not truncate.',
        );
      }
      const text = (key: string) =>
        typeof row.original[key] === 'string' ? (row.original[key] as string) : null;
      target.pending.push({
        entryId,
        sessionId,
        position: ++session.pendingEntries,
        state: 'pending',
        // The reviewed card identity follows the printing the target catalog publishes; an
        // unresolved legacy printing keeps its entry unresolved.
        cardId: row.printing_id === null ? null : (catalog.get(row.printing_id)?.cardId ?? null),
        printingId: row.printing_id,
        finish: row.finish,
        condition: row.condition === undefined || row.condition === 'UNK' ? null : row.condition,
        quantity: row.quantity,
        revision: 1,
        candidates: row.recognition_candidates.map((c) => ({
          printingId: c.printing_id,
          provider: c.provider,
          evidence: c.evidence,
        })),
        sourceLine: {
          name: text('name'),
          section: text('section'),
          set: text('set'),
          collectorNumber: text('collector_number'),
          language: text('language'),
          finish: finish.safeParse(row.original.finish).success
            ? finish.parse(row.original.finish)
            : null,
          declaredQuantity:
            typeof row.original.quantity === 'number'
              ? z.number().int().positive().parse(row.original.quantity)
              : row.quantity,
          problem: row.printing_id === null ? 'Legacy printing remains unresolved.' : null,
        },
        legacyDocument: `${doc.space}/${doc.id}`,
        legacyRowId: row.id,
      });
    }
  }
  target.sessions = [...sessions.values()];
}

/** Scan summaries and indexes must agree with retained batches, including closed tombstones. */
function validateScanIndexes(source: LegacyAccount): void {
  const headers = records(source, 'import-drafts').filter(
    (d) => d.value.provider === 'scan-session',
  );
  const batches = new Map(records(source, 'scan-drafts').map((d) => [d.id, d.value]));
  const indexes = new Map(records(source, 'scan-batch-index').map((d) => [d.id, d.value]));
  const captures = new Map(records(source, 'scan-capture-index').map((d) => [d.id, d.value]));
  for (const doc of headers) {
    const header = z
      .object({
        id: z.string(),
        state: z.enum(['pending', 'empty']),
        batches: z.number().int().nonnegative(),
        accepted: z.number().int().nonnegative(),
        pending_batches: z.number().int().nonnegative(),
        pending_copies: z.number().int().nonnegative(),
      })
      .parse(doc.value);
    if (doc.id !== `scan:${header.id}`) throw new Error('Scan header identity mismatch.');
    if (
      [...captures.values()].filter((c) => c.session_id === header.id).length !== header.accepted
    ) {
      throw new Error('Scan capture index count disagrees with accepted entries.');
    }
    if (
      records(source, 'scan-batch-index').filter((d) => d.id.startsWith(`${header.id}:`)).length !==
      header.batches
    ) {
      throw new Error('Scan batch index count disagrees with its session header.');
    }
    let pendingBatches = 0,
      pendingCopies = 0;
    for (let index = 1; index <= header.batches; index++) {
      const key = `${header.id}:${String(index).padStart(12, '0')}`;
      const indexed = indexes.get(key);
      const batch =
        typeof indexed?.batch_id === 'string' ? batches.get(indexed.batch_id) : undefined;
      const context = z
        .object({ id: z.string(), index: z.number().int() })
        .safeParse(batch?.scan_session);
      if (
        !batch ||
        !context.success ||
        context.data.id !== header.id ||
        context.data.index !== index
      ) {
        throw new Error('Scan batch index is incomplete or inconsistent.');
      }
      if (batch.state === 'pending') {
        pendingBatches++;
        const draft = pendingDraft.parse(batch);
        if (draft.id !== indexed!.batch_id)
          throw new Error('Scan batch identity differs from its index.');
        pendingCopies += draft.rows.reduce((n, r) => n + r.quantity, 0);
        for (const row of draft.rows) {
          const capture = captures.get(row.id);
          if (capture?.session_id !== header.id || capture.batch_id !== draft.id) {
            throw new Error('Pending scan row has no matching capture index.');
          }
        }
      } else if (batch.state !== 'empty') throw new Error('Unknown scan batch lifecycle state.');
    }
    if (
      pendingBatches !== header.pending_batches ||
      pendingCopies !== header.pending_copies ||
      (header.state === 'pending') !== pendingBatches > 0
    )
      throw new Error('Scan summary disagrees with retained batches.');
  }
  for (const doc of records(source, 'scan-drafts')) {
    const context = z
      .object({ id: z.string(), index: z.number().int().positive() })
      .parse(doc.value.scan_session);
    const header = headers.find((h) => h.value.id === context.id);
    const indexed = indexes.get(`${context.id}:${String(context.index).padStart(12, '0')}`);
    if (!header || context.index > Number(header.value.batches) || indexed?.batch_id !== doc.id) {
      throw new Error('Scan batch has no matching session index.');
    }
  }
  for (const doc of records(source, 'scan-batch-index')) {
    const indexed = z.object({ batch_id: z.string().min(1) }).parse(doc.value);
    const batch = batches.get(indexed.batch_id);
    const context = z
      .object({ id: z.string().min(1), index: z.number().int().positive() })
      .parse(batch?.scan_session);
    if (
      doc.id !== `${context.id}:${String(context.index).padStart(12, '0')}` ||
      !headers.some((h) => h.value.id === context.id && context.index <= Number(h.value.batches))
    ) {
      throw new Error('Orphaned or contradictory scan batch index.');
    }
  }
  for (const doc of records(source, 'scan-capture-index')) {
    const capture = z
      .object({ session_id: z.string().min(1), batch_id: z.string().min(1) })
      .parse(doc.value);
    const batch = batches.get(capture.batch_id);
    const context = z
      .object({ id: z.string().min(1), index: z.number().int().positive() })
      .parse(batch?.scan_session);
    if (
      context.id !== capture.session_id ||
      !headers.some((h) => h.value.id === capture.session_id)
    ) {
      throw new Error('Orphaned or contradictory scan capture index.');
    }
  }
}

/** Reject changed artifacts before a future rehearsal loader is allowed to consume them. */
export function verifyPlan(plan: MigrationPlan): void {
  const { planDigest, ...content } = plan;
  if (
    digest(canonical(content)) !== planDigest ||
    digest(canonical(plan.archive)) !== plan.sourceDigest
  ) {
    throw new Error('Migration plan or source archive has changed.');
  }
  const rebuilt = prepareMigration(plan.archive);
  if (rebuilt.planDigest !== planDigest)
    throw new Error('Plan differs from conversion of its source archive.');
  if (plan.state !== 'prepared') throw new Error('Migration plan has unresolved blockers.');
}
