/**
 * The prepared plan the offline migration utility emits and the deterministic batching of one
 * prepared account (docs/migration.md#offline-commands, docs/migration.md#rehearsal-and-execution-gates).
 *
 * The utility owns legacy interpretation and conversion evidence; this module owns what the target
 * loader accepts. A plan is consumed only as a verified prepared plan: its format marker, its
 * prepared state, the caller's exact source digest and the plan's own digests must all hold, and
 * every record it carries must be representable by this component's private records and read
 * contract. The canonical JSON encoding used for the digests is the one the utility computes them
 * with (scripts/migration/legacy.ts), so a plan that passed the utility's verification verifies
 * here as well. Loading is repeatable because a batch is keyed by the digest of exactly the
 * records it writes, not by the run that writes it.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { finishes } from '../../catalog/index.js';
import { UserCardsError } from './errors.js';
import {
  USERCARDS_LIMITS,
  associationLevelsByTagKind,
  associationTargetLevels,
  copyConditions,
  userTagKinds,
  type Association,
  type ImportCandidate,
  type ImportEntry,
  type ImportSession,
  type ImportSourceLine,
  type PhysicalCopy,
  type Tag,
  type TagKind,
} from './model.js';
import { sourceLineKey } from './source-line-identity.js';

export const migrationPlanFormat = 'keeper-migration-plan-v1';
export const migrationPlanStates = ['prepared', 'blocked'] as const;
export type MigrationPlanState = (typeof migrationPlanStates)[number];

/**
 * One prepared account: the records the loader stores for a target account, in the identities the
 * offline conversion assigned them. Copies, tags, associations, pending sessions and entries are
 * fresh records, so every one carries revision 1.
 */
export interface MigrationPlanAccount {
  readonly accountId: string;
  readonly copies: readonly PhysicalCopy[];
  readonly tags: readonly Tag[];
  readonly associations: readonly Association[];
  readonly sessions: readonly ImportSession[];
  readonly pending: readonly ImportEntry[];
}

/**
 * A verified prepared plan: the utility's `keeper-migration-plan-v1` artifact. The loader reads
 * only these fields; the utility's additional conversion evidence (`issues`, `groups`, `expected`
 * and per-record legacy references) travels inside the digest-protected artifact.
 */
export interface MigrationPlan {
  readonly format: typeof migrationPlanFormat;
  readonly state: MigrationPlanState;
  readonly snapshotId: string;
  readonly sourceDigest: string;
  readonly planDigest: string;
  readonly accounts: readonly MigrationPlanAccount[];
  /** Exact input archive, retained durably by the loader as the migration's source evidence. */
  readonly archive: unknown;
}

const identifierSchema = z.string().min(1).max(USERCARDS_LIMITS.maxIdentifierLength);
const digestSchema = z.string().min(1).max(128);
const quantitySchema = z.number().int().min(1).max(USERCARDS_LIMITS.maxAssociationQuantity);
const candidateSchema = z.object({
  printingId: identifierSchema,
  provider: identifierSchema,
  evidence: identifierSchema,
});
const sourceLineSchema = z.object({
  printingId: identifierSchema.nullable().default(null),
  name: identifierSchema.nullable(),
  section: identifierSchema.nullable(),
  set: identifierSchema.nullable(),
  collectorNumber: identifierSchema.nullable(),
  language: identifierSchema.nullable(),
  finish: z.enum(finishes).nullable(),
  declaredQuantity: quantitySchema,
  problem: z.string().min(1).max(USERCARDS_LIMITS.maxSourceProblemLength).nullable(),
});
const copySchema = z.object({
  copyId: identifierSchema,
  printingId: identifierSchema,
  finish: z.enum(finishes),
  condition: z.enum(copyConditions).nullable(),
  revision: z.literal(1),
});
const tagSchema = z.object({
  tagId: identifierSchema,
  kind: z.enum(userTagKinds),
  label: z.string().min(1).max(USERCARDS_LIMITS.maxIdentifierLength),
  system: z.literal(false),
  revision: z.literal(1),
});
const associationSchema = z.object({
  associationId: identifierSchema,
  tagId: identifierSchema,
  targetLevel: z.enum(associationTargetLevels),
  targetId: identifierSchema,
  quantity: quantitySchema.nullable(),
  revision: z.literal(1),
});
const sessionSchema = z.object({
  sessionId: identifierSchema,
  sourceKind: identifierSchema,
  sourceId: identifierSchema,
  sourceReference: z.string().min(1).max(USERCARDS_LIMITS.maxSourceReferenceLength).nullable(),
  state: z.literal('pending'),
  pendingEntries: z.number().int().min(0),
  confirmedEntries: z.literal(0),
  discardedEntries: z.literal(0),
  revision: z.literal(1),
});
const entrySchema = z.object({
  entryId: identifierSchema,
  sessionId: identifierSchema,
  position: z.number().int().min(1),
  state: z.literal('pending'),
  cardId: identifierSchema.nullable(),
  printingId: identifierSchema.nullable(),
  finish: z.enum(finishes).nullable(),
  condition: z.enum(copyConditions).nullable(),
  quantity: quantitySchema,
  candidates: z.array(candidateSchema).max(USERCARDS_LIMITS.maxImportCandidates),
  sourceLine: sourceLineSchema.nullable(),
  revision: z.literal(1),
});
const accountSchema = z.object({
  accountId: identifierSchema,
  copies: z.array(copySchema),
  tags: z.array(tagSchema),
  associations: z.array(associationSchema),
  sessions: z.array(sessionSchema),
  pending: z.array(entrySchema),
});
const planSchema = z.object({
  format: z.literal(migrationPlanFormat),
  state: z.enum(migrationPlanStates),
  snapshotId: identifierSchema,
  sourceDigest: digestSchema,
  planDigest: digestSchema,
  accounts: z.array(accountSchema),
  archive: z.unknown(),
});

function migrationPlanError(message: string): UserCardsError {
  return new UserCardsError('invalid-request', message);
}

/**
 * Canonical JSON of one plan value: object keys sorted, so an equivalent plan written in another
 * property order carries the same digest. The encoding matches the offline utility's canonical
 * encoding, which is the authoritative home of the plan format.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('The migration plan carries a value that is not JSON.');
  }
  return encoded;
}

function contentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function planDigestOf(value: unknown): string | null {
  try {
    return contentDigest(canonicalJson(value));
  } catch {
    return null;
  }
}

/**
 * Verifies one presented artifact and returns the account records it carries. A plan whose
 * prepared state, source digest, plan digest or archive digest does not hold is refused instead of
 * being partly loaded, and the same applies to a plan whose records repeat an identity, reference
 * a record it does not carry, or exceed what the private records can store
 * (docs/migration.md#rehearsal-and-execution-gates).
 */
export function verifyMigrationPlan(raw: unknown, sourceDigest: string): MigrationPlan {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw migrationPlanError('The migration plan is not a readable keeper-migration-plan-v1 plan.');
  }
  const plan = parsed.data;
  if (plan.state !== 'prepared') {
    throw migrationPlanError(
      'The migration plan has unresolved blockers; resolve them before loading.',
    );
  }
  if (plan.sourceDigest !== sourceDigest) {
    throw migrationPlanError('The supplied source digest does not match the prepared plan.');
  }
  const content = { ...(raw as Record<string, unknown>) };
  delete content.planDigest;
  if (planDigestOf(content) !== plan.planDigest) {
    throw migrationPlanError('The migration plan does not match its plan digest.');
  }
  if (planDigestOf(plan.archive) !== plan.sourceDigest) {
    throw migrationPlanError('The migration plan does not match the source digest of its archive.');
  }
  const accounts = new Set<string>();
  for (const account of plan.accounts) {
    if (accounts.has(account.accountId)) {
      throw migrationPlanError('The migration plan carries an account more than once.');
    }
    accounts.add(account.accountId);
    verifyPlanAccount(account);
  }
  return plan;
}

/** Every record of one prepared account is fresh, distinct and complete before it is batched. */
function verifyPlanAccount(account: MigrationPlanAccount): void {
  const tags = new Map(account.tags.map((tag) => [tag.tagId, tag] as const));
  if (tags.size !== account.tags.length) {
    throw migrationPlanError('The migration plan repeats a tag identity.');
  }
  const copies = new Set(account.copies.map((copy) => copy.copyId));
  if (copies.size !== account.copies.length) {
    throw migrationPlanError('The migration plan repeats a copy identity.');
  }
  const associations = new Set(account.associations.map((entry) => entry.associationId));
  if (associations.size !== account.associations.length) {
    throw migrationPlanError('The migration plan repeats an association identity.');
  }
  for (const association of account.associations) {
    const tag = tags.get(association.tagId);
    if (tag === undefined) {
      throw migrationPlanError('An association references a tag the plan does not carry.');
    }
    if (!associationLevelsByTagKind[tag.kind].includes(association.targetLevel)) {
      throw migrationPlanError('An association targets a level its tag does not associate.');
    }
    if ((association.targetLevel === 'copy') !== (association.quantity === null)) {
      throw migrationPlanError(
        'An association does not carry the quantity its target level means.',
      );
    }
    if (association.targetLevel === 'copy' && !copies.has(association.targetId)) {
      throw migrationPlanError('An association references a copy the plan does not carry.');
    }
  }
  const sessions = new Set(account.sessions.map((session) => session.sessionId));
  if (sessions.size !== account.sessions.length) {
    throw migrationPlanError('The migration plan repeats an import session.');
  }
  const moxfieldSessions = new Set(
    account.sessions
      .filter((session) => session.sourceKind === 'moxfield')
      .map((session) => session.sessionId),
  );
  const entries = new Set<string>();
  const positions = new Map<string, Set<number>>();
  const pending = new Map<string, number>();
  for (const entry of account.pending) {
    if (entries.has(entry.entryId)) {
      throw migrationPlanError('The migration plan repeats a pending entry identity.');
    }
    entries.add(entry.entryId);
    if (!sessions.has(entry.sessionId)) {
      throw migrationPlanError('A pending entry references an import the plan does not carry.');
    }
    if (
      moxfieldSessions.has(entry.sessionId) &&
      (entry.sourceLine?.printingId == null || entry.sourceLine.finish === null)
    ) {
      throw migrationPlanError(
        'Moxfield source replay identity is unavailable; prepare a compatible plan from retained source evidence.',
      );
    }
    const seen = positions.get(entry.sessionId) ?? new Set<number>();
    if (seen.has(entry.position)) {
      throw migrationPlanError('A pending entry repeats a position in its import.');
    }
    seen.add(entry.position);
    positions.set(entry.sessionId, seen);
    pending.set(entry.sessionId, (pending.get(entry.sessionId) ?? 0) + 1);
    const alternatives = new Set(entry.candidates.map((candidate) => candidateKey(candidate)));
    if (alternatives.size !== entry.candidates.length) {
      throw migrationPlanError('A pending entry repeats a recognition alternative.');
    }
  }
  for (const session of account.sessions) {
    if ((pending.get(session.sessionId) ?? 0) !== session.pendingEntries) {
      throw migrationPlanError('A plan import session does not agree with its pending entries.');
    }
  }
}

function candidateKey(candidate: ImportCandidate): string {
  return [candidate.printingId, candidate.provider, candidate.evidence].join('\u0000');
}

/**
 * Durable archive text in bounded chunks (docs/migration.md#rehearsal-and-execution-gates). The
 * concatenated chunks are the canonical archive the plan's source digest covers; chunks never
 * split a character, and each one stays below the deployed read transport's per-row bound.
 */
export function migrationArchiveChunks(archive: unknown): readonly string[] {
  const text = canonicalJson(archive);
  const chunks: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > USERCARDS_LIMITS.maxMigrationArchiveChunkLength) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  chunks.push(chunk);
  return chunks;
}

/** Digest of the archive the loader stored; the plan's source digest is this value. */
export function migrationArchiveDigest(text: string): string {
  return contentDigest(text);
}

/**
 * Durable identity of one retained source line, in the form the ordinary source reconciliation
 * derives from a parsed line (docs/user-cards.md#source-imports). It is computed from what the
 * source published and never from the reviewed values a user later set, so a source re-staged
 * after the migration recognizes the migrated quantity instead of staging it again. A retained
 * source line retains its published printing separately from the reviewed printing.
 */
export function migrationSourceLineKey(line: ImportSourceLine): string {
  return sourceLineKey(line);
}

/** One planned association with the kind of its tag, which the private association row stores. */
export interface PlannedAssociation {
  readonly association: Association;
  readonly tagKind: TagKind;
}

type MigrationBatchContent =
  | { readonly kind: 'tags'; readonly tags: readonly Tag[] }
  | {
      readonly kind: 'copies';
      readonly copies: readonly PhysicalCopy[];
      /** Copy memberships of exactly these copies, so a copy publishes with its location. */
      readonly memberships: readonly PlannedAssociation[];
    }
  | { readonly kind: 'associations'; readonly associations: readonly PlannedAssociation[] }
  | { readonly kind: 'sessions'; readonly sessions: readonly ImportSession[] }
  | { readonly kind: 'entries'; readonly entries: readonly ImportEntry[] };

/**
 * One migration batch: the records one transaction writes with its replay receipt and its
 * publication. Batches are chunks of one account in a fixed order — tags, copies with their copy
 * memberships, further associations, sessions, pending entries — so an interrupted load resumes at
 * its first missing batch and a recorded batch is recognized by its own content
 * (docs/migration.md#rehearsal-and-execution-gates).
 */
export type MigrationBatch = MigrationBatchContent & {
  readonly index: number;
  /** Digest of the batch's own records; a retry skips a recorded identical batch. */
  readonly fingerprint: string;
};

export function migrationBatches(account: MigrationPlanAccount): readonly MigrationBatch[] {
  const tags = new Map(account.tags.map((tag) => [tag.tagId, tag] as const));
  const copies = new Set(account.copies.map((copy) => copy.copyId));
  const memberships = new Map<string, PlannedAssociation[]>();
  const associations: PlannedAssociation[] = [];
  for (const association of [...account.associations].sort(compareAssociationIdentity)) {
    const tag = tags.get(association.tagId);
    if (tag === undefined) {
      throw migrationPlanError('An association references a tag the plan does not carry.');
    }
    const planned = { association, tagKind: tag.kind };
    if (association.targetLevel !== 'copy') {
      associations.push(planned);
      continue;
    }
    if (!copies.has(association.targetId)) {
      throw migrationPlanError('An association references a copy the plan does not carry.');
    }
    memberships.set(association.targetId, [
      ...(memberships.get(association.targetId) ?? []),
      planned,
    ]);
  }
  const size = USERCARDS_LIMITS.maxMigrationBatchRecords;
  const contents: MigrationBatchContent[] = [];
  for (const group of chunks([...account.tags].sort(compareTagIdentity), size)) {
    contents.push({ kind: 'tags', tags: group });
  }
  for (const group of chunks([...account.copies].sort(compareCopyIdentity), size)) {
    contents.push({
      kind: 'copies',
      copies: group,
      memberships: group.flatMap((copy) => memberships.get(copy.copyId) ?? []),
    });
  }
  for (const group of chunks(associations, size)) {
    contents.push({ kind: 'associations', associations: group });
  }
  for (const group of chunks([...account.sessions].sort(compareSessionIdentity), size)) {
    contents.push({ kind: 'sessions', sessions: group });
  }
  for (const group of chunks([...account.pending].sort(compareEntryIdentity), size)) {
    contents.push({ kind: 'entries', entries: group });
  }
  return contents.map((content, index) => ({
    ...content,
    index,
    fingerprint: contentDigest(canonicalJson(batchContent(content))),
  }));
}

/** The batch's own records in a fixed encoding, so its digest never depends on property order. */
function batchContent(content: MigrationBatchContent): unknown {
  switch (content.kind) {
    case 'tags':
      return { kind: content.kind, tags: content.tags.map(tagTuple) };
    case 'copies':
      return {
        kind: content.kind,
        copies: content.copies.map(copyTuple),
        memberships: content.memberships.map(plannedAssociationTuple),
      };
    case 'associations':
      return {
        kind: content.kind,
        associations: content.associations.map(plannedAssociationTuple),
      };
    case 'sessions':
      return { kind: content.kind, sessions: content.sessions.map(sessionTuple) };
    case 'entries':
      return { kind: content.kind, entries: content.entries.map(entryTuple) };
  }
}

function tagTuple(tag: Tag): readonly unknown[] {
  return [tag.tagId, tag.kind, tag.label];
}
function copyTuple(copy: PhysicalCopy): readonly unknown[] {
  return [copy.copyId, copy.printingId, copy.finish, copy.condition];
}
function plannedAssociationTuple(planned: PlannedAssociation): readonly unknown[] {
  const { association, tagKind } = planned;
  return [
    association.associationId,
    association.tagId,
    tagKind,
    association.targetLevel,
    association.targetId,
    association.quantity,
  ];
}
function sessionTuple(session: ImportSession): readonly unknown[] {
  return [
    session.sessionId,
    session.sourceKind,
    session.sourceId,
    session.sourceReference,
    session.revision,
  ];
}
function entryTuple(entry: ImportEntry): readonly unknown[] {
  return [
    entry.entryId,
    entry.sessionId,
    entry.position,
    entry.state,
    entry.cardId,
    entry.printingId,
    entry.finish,
    entry.condition,
    entry.quantity,
    entry.revision,
    entry.candidates.map((candidate) => [
      candidate.printingId,
      candidate.provider,
      candidate.evidence,
    ]),
    entry.sourceLine === null
      ? null
      : [
          entry.sourceLine.printingId,
          entry.sourceLine.name,
          entry.sourceLine.section,
          entry.sourceLine.set,
          entry.sourceLine.collectorNumber,
          entry.sourceLine.language,
          entry.sourceLine.finish,
          entry.sourceLine.declaredQuantity,
          entry.sourceLine.problem,
        ],
  ];
}

function compareTagIdentity(left: Tag, right: Tag): number {
  return left.tagId.localeCompare(right.tagId);
}
function compareCopyIdentity(left: PhysicalCopy, right: PhysicalCopy): number {
  return left.copyId.localeCompare(right.copyId);
}
function compareAssociationIdentity(left: Association, right: Association): number {
  return left.associationId.localeCompare(right.associationId);
}
function compareSessionIdentity(left: ImportSession, right: ImportSession): number {
  return left.sessionId.localeCompare(right.sessionId);
}
function compareEntryIdentity(left: ImportEntry, right: ImportEntry): number {
  return left.sessionId.localeCompare(right.sessionId) || left.position - right.position;
}

function chunks<T>(records: readonly T[], size: number): readonly (readonly T[])[] {
  const grouped: T[][] = [];
  for (let start = 0; start < records.length; start += size) {
    grouped.push(records.slice(start, start + size));
  }
  return grouped;
}
