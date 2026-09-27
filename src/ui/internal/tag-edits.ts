/**
 * Tag and association editing of the organization views
 * (docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations).
 *
 * The tags page and the tag view rename tags, add associations, change an association's intended
 * quantity, refine or broaden its card/printing target and move a copy's single physical location
 * through the private UserCards contract Application supplies. Every change quotes the revision
 * the view read, so a record that changed meanwhile conflicts instead of being overwritten, and a
 * change that cannot be confirmed — a lost response, a busy service or a cancellation after
 * dispatch — stays unknown: its record is read for review, but neither the record nor its revision
 * identifies which operation changed it, so only a change's own successful response establishes
 * commitment (docs/application.md#construction-and-request-boundary). Unsaved input stays with the
 * view for review and retry, and a saved outcome is presented only after the operation reports it
 * committed (docs/user-interface.md#browsing-and-organization).
 */

import type { UserCardsClient } from '../../application/index.js';
import type {
  Association,
  AssociationChangeResult,
  AssociationListResult,
  AssociationReadResult,
  AssociationRemovalResult,
  AssociationTargetLevel,
  CopyId,
  CopyLocationResult,
  CopyReadResult,
  CreateAssociationInput,
  CreateTagInput,
  PhysicalCopy,
  RenameTagInput,
  SetCopyLocationInput,
  Tag,
  TagChangeResult,
  TagId,
  TagListOptions,
  TagListResult,
  TagReadResult,
  UserTagKind,
} from '../../usercards/index.js';

import { isUiDefiniteFailure, readUiFailureCode, readUiFailureMessage } from './failure.js';
import type { UiEntryTarget, UiOperationOutcome, UiToolRequest } from './list.js';

/**
 * Tag kinds the organization views create and edit. The values are the UserCards provider's
 * published vocabulary; the list is declared here because the organization pages own the control
 * vocabulary and a provider change needs a deliberate decision about the controls it serves.
 */
export const uiTagKinds = [
  'deck',
  'wishlist',
  'location',
  'other',
] as const satisfies readonly UserTagKind[];

export type UiTagKind = (typeof uiTagKinds)[number];

/**
 * Largest intended quantity an association control offers. The bound mirrors the UserCards
 * provider's published maximum, so a value the provider accepts stays enterable.
 */
export const uiMaxAssociationQuantity = 1000;

/**
 * Association levels each tag kind presents. A wishlist expresses intent for a card or one of its
 * printings; a deck and another grouping also hold physical copies; a location holds only the
 * copies physically assigned to it (docs/architecture.md#tags-and-associations).
 */
export const uiAssociationLevelsByTagKind: Readonly<
  Record<UiTagKind, readonly AssociationTargetLevel[]>
> = {
  deck: ['card', 'printing', 'copy'],
  wishlist: ['card', 'printing'],
  location: ['copy'],
  other: ['card', 'printing', 'copy'],
};

/** Display name of one tag kind. */
export function uiTagKindLabel(kind: UiTagKind): string {
  switch (kind) {
    case 'deck':
      return 'Deck';
    case 'wishlist':
      return 'Wishlist';
    case 'location':
      return 'Location';
    case 'other':
      return 'Other';
  }
}

/** Display name of one association target level. */
export function uiAssociationLevelLabel(level: AssociationTargetLevel): string {
  switch (level) {
    case 'card':
      return 'Card';
    case 'printing':
      return 'Printing';
    case 'copy':
      return 'Physical copy';
  }
}

/**
 * The private tag, association and location operations the organization views present. It is the
 * narrow part of Application's browser contract these views use, so a consumer depends only on the
 * capabilities it presents (docs/architecture.md#composition-and-replacement).
 */
export type UiTagClient = Pick<
  UserCardsClient,
  | 'readCopies'
  | 'listTags'
  | 'readTags'
  | 'createTag'
  | 'renameTag'
  | 'listAssociations'
  | 'readAssociations'
  | 'createAssociation'
  | 'changeAssociation'
  | 'removeAssociation'
  | 'setCopyLocation'
>;

/** Private tag access of the organization views. */
export interface UiTagAccess {
  /** One page of the account's tags, ordered by stable identity. */
  list(options?: TagListOptions, signal?: AbortSignal): Promise<TagListResult>;
  /** Authorized tags of the requested references, with the references this account has none for. */
  read(tagIds: readonly TagId[], signal?: AbortSignal): Promise<TagReadResult>;
  /** One page of one tag's associations, ordered by stable identity. */
  associations(
    tagId: TagId,
    options?: TagListOptions,
    signal?: AbortSignal,
  ): Promise<AssociationListResult>;
  /** Authorized associations of the requested references, for reviewing a change's outcome. */
  readAssociations(
    associationIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssociationReadResult>;
  /** Authorized copies of the requested references; a location move quotes their revisions. */
  readCopies(copyIds: readonly CopyId[], signal?: AbortSignal): Promise<CopyReadResult>;
  createTag(input: CreateTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  renameTag(input: RenameTagInput, signal?: AbortSignal): Promise<TagChangeResult>;
  createAssociation(
    input: CreateAssociationInput,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  changeAssociation(
    input: AssociationCorrection,
    signal?: AbortSignal,
  ): Promise<AssociationChangeResult>;
  removeAssociation(
    input: AssociationRemoval,
    signal?: AbortSignal,
  ): Promise<AssociationRemovalResult>;
  setCopyLocation(input: SetCopyLocationInput, signal?: AbortSignal): Promise<CopyLocationResult>;
}

/** One association change as the views present it: the target level, identity and revision. */
export interface AssociationCorrection {
  readonly associationId: string;
  readonly expectedRevision: number;
  readonly targetLevel: AssociationTargetLevel;
  readonly targetId: string;
  readonly quantity: number | null;
}

/** One association removal as the views present it. */
export interface AssociationRemoval {
  readonly associationId: string;
  readonly expectedRevision: number;
}

/** Builds the tag access over the private contract Application supplies. */
export function createTagAccess(userCards: UiTagClient): UiTagAccess {
  for (const operation of [
    'readCopies',
    'listTags',
    'readTags',
    'createTag',
    'renameTag',
    'listAssociations',
    'readAssociations',
    'createAssociation',
    'changeAssociation',
    'removeAssociation',
    'setCopyLocation',
  ] as const) {
    if (typeof userCards?.[operation] !== 'function') {
      throw new TypeError('The organization views read and change tags through UserCards.');
    }
  }
  return {
    list: (options, signal) => userCards.listTags(options, signal),
    read: (tagIds, signal) => userCards.readTags(tagIds, signal),
    associations: (tagId, options, signal) => userCards.listAssociations(tagId, options, signal),
    readAssociations: (associationIds, signal) =>
      userCards.readAssociations(associationIds, signal),
    readCopies: (copyIds, signal) => userCards.readCopies(copyIds, signal),
    createTag: (input, signal) => userCards.createTag(input, signal),
    renameTag: (input, signal) => userCards.renameTag(input, signal),
    createAssociation: (input, signal) => userCards.createAssociation(input, signal),
    changeAssociation: (input, signal) => userCards.changeAssociation(input, signal),
    removeAssociation: (input, signal) => userCards.removeAssociation(input, signal),
    setCopyLocation: (input, signal) => userCards.setCopyLocation(input, signal),
  };
}

/** Outcome of one private change as an organization view presents it. */
export interface UiChangeOutcome<Record> {
  readonly status: UiOperationOutcome['status'];
  /** User-facing explanation, or null when the committed change needs none. */
  readonly message: string | null;
  /** Committed record, or the record a recovery read observed; null when neither is available. */
  readonly record: Record | null;
}

/** Creates one tag through the private contract. */
export async function createTag(
  access: UiTagAccess,
  input: CreateTagInput,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<Tag>> {
  return commit(
    () => access.createTag(input, signal).then((result) => result.tag),
    async () => null,
    'The tag was not created.',
  );
}

/**
 * Renames one tag, quoting the revision the view read. A conflict or a definite failure keeps the
 * caller's input; a lost response reads the tag for review while the outcome stays unknown.
 */
export async function renameTag(
  access: UiTagAccess,
  input: RenameTagInput,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<Tag>> {
  return commit(
    () => access.renameTag(input, signal).then((result) => result.tag),
    async () => {
      try {
        const read = await access.read([input.tagId], signal);
        return read.tags.get(input.tagId) ?? null;
      } catch {
        return null;
      }
    },
    'The rename was not saved.',
  );
}

/** Adds one association through the private contract. */
export async function addAssociation(
  access: UiTagAccess,
  input: CreateAssociationInput,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<Association>> {
  return commit(
    () => access.createAssociation(input, signal).then((result) => result.association),
    async () => null,
    'The association was not added.',
  );
}

/**
 * Changes one association's intended quantity or target level, quoting the revision the view read.
 * A lost response reads the association back for review while the outcome stays unknown.
 */
export async function saveAssociation(
  access: UiTagAccess,
  input: AssociationCorrection,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<Association>> {
  return commit(
    () => access.changeAssociation(input, signal).then((result) => result.association),
    async () => {
      try {
        const read = await access.readAssociations([input.associationId], signal);
        return read.associations.get(input.associationId) ?? null;
      } catch {
        return null;
      }
    },
    'The association was not saved.',
  );
}

/** Removes one association, quoting the revision the view read. */
export async function removeAssociation(
  access: UiTagAccess,
  input: AssociationRemoval,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<string>> {
  return commit(
    () => access.removeAssociation(input, signal).then((result) => result.associationId),
    async () => null,
    'The association was not removed.',
  );
}

/**
 * Moves or clears one copy's single physical location, quoting the revision the view read. A lost
 * response reads the copy back for review while the outcome stays unknown.
 */
async function moveCopyLocation(
  access: UiTagAccess,
  input: SetCopyLocationInput,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<PhysicalCopy>> {
  return commit(
    () => access.setCopyLocation(input, signal).then((result) => result.copy),
    async () => {
      try {
        const read = await access.readCopies([input.copyId], signal);
        return read.copies.get(input.copyId) ?? null;
      } catch {
        return null;
      }
    },
    'The copy’s location was not saved.',
  );
}

/**
 * One private change: a success reports its committed record; a revision conflict and a definite
 * failure report the operation's own outcome; every other rejection stays unknown and recovers the
 * record for review without inferring the operation's outcome
 * (docs/application.md#construction-and-request-boundary).
 */
async function commit<Record>(
  change: () => Promise<Record>,
  recover: () => Promise<Record | null>,
  fallback: string,
): Promise<UiChangeOutcome<Record>> {
  try {
    return { status: 'committed', message: null, record: await change() };
  } catch (cause) {
    const code = readUiFailureCode(cause);
    if (code === 'conflict') {
      return { status: 'conflict', message: readUiFailureMessage(cause, fallback), record: null };
    }
    if (code !== null && isUiDefiniteFailure(code)) {
      return { status: 'failed', message: readUiFailureMessage(cause, fallback), record: null };
    }
    const record = await recover();
    return {
      status: 'unknown',
      message:
        record === null
          ? 'The outcome is unknown. Reload the view before retrying.'
          : 'The outcome is unknown. Review the record before retrying.',
      record,
    };
  }
}

/**
 * One tool that adds the explicit selected entries to a tag through its own operation: a card or
 * printing entry becomes an intended association carrying the quantity the page presents, a
 * physical copy becomes copy membership — or, for a location, the copy's single physical location
 * — and a selection that names an entry the tag cannot associate acts on nothing. The tool reports
 * the outcome of the whole selection; partial work is never reported as saved
 * (docs/user-interface.md#browsing-and-organization).
 */
export interface UiAddToTagTool {
  readonly id: string;
  readonly label: string;
  readonly tool: {
    invoke(request: UiToolRequest): Promise<UiAddOutcome>;
  };
}

/**
 * Outcome of one add over a selection, with the number of targets whose change committed. A
 * caller reconciles its lists whenever a write committed or stays uncertain, so a partial addition
 * is visible instead of presented as an unchanged result, and only a committed change is reported
 * as saved (docs/user-interface.md#browsing-and-organization).
 */
export interface UiAddOutcome extends UiOperationOutcome {
  /** Targets whose change committed. */
  readonly committed: number;
  /** Targets whose outcome stays unknown. */
  readonly unknown: number;
}

export function addToTagTool(options: {
  readonly id: string;
  readonly label: string;
  readonly access: UiTagAccess;
  readonly tag: () => Tag | null;
  /** Intended quantity the page currently offers a card or printing entry. */
  quantity(): number | null;
  /** What the user must choose before the tool can act, reported when `quantity` names none. */
  readonly guidance: string;
}): UiAddToTagTool {
  return {
    id: options.id,
    label: options.label,
    tool: {
      invoke(request: UiToolRequest): Promise<UiAddOutcome> {
        return addSelection(options, request);
      },
    },
  };
}

async function addSelection(
  options: Parameters<typeof addToTagTool>[0],
  request: UiToolRequest,
): Promise<UiAddOutcome> {
  const tag = options.tag();
  if (tag === null) {
    return {
      status: 'failed',
      message: 'The tag is not available.',
      committed: 0,
      unknown: 0,
    };
  }
  if (request.targets.length === 0) {
    return {
      status: 'failed',
      message: 'Select the entries to add.',
      committed: 0,
      unknown: 0,
    };
  }
  const quantity = options.quantity();
  const counts = { committed: 0, conflict: 0, failed: 0, unknown: 0 };
  const failures: string[] = [];
  for (const target of request.targets) {
    const outcome = await addTarget(options.access, tag, target, quantity, request.signal);
    counts[outcome.status] += 1;
    if (outcome.status !== 'committed' && outcome.message !== null) {
      failures.push(outcome.message);
    }
  }
  return addOutcome(counts, failures, request.targets.length, options.guidance);
}

/** Adds one selected target to the tag; a location holds copies through their location move. */
async function addTarget(
  access: UiTagAccess,
  tag: Tag,
  target: UiEntryTarget,
  quantity: number | null,
  signal: AbortSignal,
): Promise<UiChangeOutcome<unknown>> {
  if (target.kind === 'copy') {
    return tag.kind === 'location'
      ? moveCopyById(access, target.copyId, tag.tagId, signal)
      : addAssociation(
          access,
          { tagId: tag.tagId, targetLevel: 'copy', targetId: target.copyId },
          signal,
        );
  }
  if (quantity === null) {
    return { status: 'failed', message: 'Choose the intended quantity to add.', record: null };
  }
  return addAssociation(
    access,
    { tagId: tag.tagId, targetLevel: target.kind, targetId: targetIdOf(target), quantity },
    signal,
  );
}

/**
 * Moves one copy into a location tag — or clears its location — quoting the revision one private
 * read observed. A copy the account no longer holds is a failure, never a silent move.
 */
export async function moveCopyById(
  access: UiTagAccess,
  copyId: CopyId,
  locationTagId: TagId | null,
  signal?: AbortSignal,
): Promise<UiChangeOutcome<PhysicalCopy>> {
  let copy: PhysicalCopy | null;
  try {
    const read = await access.readCopies([copyId], signal);
    copy = read.copies.get(copyId) ?? null;
  } catch (cause) {
    return {
      status: 'failed',
      message: `The copy could not be read: ${readUiFailureMessage(cause, 'unknown failure')}`,
      record: null,
    };
  }
  if (copy === null) {
    return { status: 'failed', message: 'The copy is no longer in the collection.', record: null };
  }
  return moveCopyLocation(
    access,
    { copyId, locationTagId, expectedRevision: copy.revision },
    signal,
  );
}

function targetIdOf(target: Exclude<UiEntryTarget, { kind: 'copy' }>): string {
  return target.kind === 'card' ? target.cardId : target.printingId;
}

/**
 * Outcome of one add over the whole selection. Committed portions are reported beside the failures
 * that did not commit, and every per-target failure keeps its own message, so a revision conflict
 * of a location move is never presented as duplicate membership. Partial work is never reported as
 * saved.
 */
function addOutcome(
  counts: { committed: number; conflict: number; failed: number; unknown: number },
  failures: readonly string[],
  total: number,
  guidance: string,
): UiAddOutcome {
  const notAdded = counts.conflict + counts.failed;
  const detail = [...new Set(failures)].join(' ');
  const partial = `${counts.committed} of ${total} entries were added; ${notAdded} were not.`;
  if (counts.unknown > 0) {
    return {
      status: 'unknown',
      message: `${partial} ${counts.unknown} of ${total} entries have an unknown outcome. ${detail} Review them before retrying.`,
      committed: counts.committed,
      unknown: counts.unknown,
    };
  }
  if (counts.conflict > 0 && counts.failed === 0) {
    return {
      status: 'conflict',
      message: `${partial} ${detail}`.trim(),
      committed: counts.committed,
      unknown: 0,
    };
  }
  if (notAdded > 0) {
    return {
      status: 'failed',
      message: `${partial} ${detail} ${counts.committed === 0 ? guidance : ''}`.trim(),
      committed: counts.committed,
      unknown: 0,
    };
  }
  return {
    status: 'committed',
    message: `Added ${total} ${total === 1 ? 'entry' : 'entries'} to the tag.`,
    committed: counts.committed,
    unknown: 0,
  };
}
