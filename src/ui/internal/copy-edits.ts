/**
 * Copy editing of the collection views (docs/user-interface.md#browsing-and-organization,
 * docs/user-cards.md#records-and-associations).
 *
 * The collection and card-details views correct physical copies through the private UserCards
 * contract Application supplies. One correction quotes the revision the view read, so a copy that
 * changed meanwhile conflicts instead of being overwritten, and a correction that cannot be
 * confirmed — a lost response, a busy service or a cancellation after dispatch — stays unknown.
 * Recovery reads the current copy for review, but neither its attributes nor its revision identify
 * which operation changed it. Only the correction's successful response establishes commitment
 * (docs/application.md#construction-and-request-boundary). A bulk change names every selected copy
 * explicitly, reads each copy's revision itself and reports the counts it actually committed; a
 * partial change is never reported as success
 * (docs/user-interface.md#browsing-and-organization, docs/application.md#interface).
 */

import type { Finish } from '../../catalog/index.js';
import type {
  UserCardsAccountOperations,
  UserCardsConstraints,
  UserCardsOperation,
} from '../../usercards/browser.js';
import type { CopyChangeResult, CopyCondition, PhysicalCopy } from '../../usercards/index.js';

import type {
  CardListOperationOutcome,
  CardListTool,
  CardListToolRequest,
} from '../../card-list/index.js';
import { readUiFailureMessage } from './failure.js';

/**
 * Conditions the copy corrections offer. The values are the UserCards provider's published
 * vocabulary; the list is declared here because the copy views own the control vocabulary and a
 * provider change needs a deliberate decision about the controls it serves.
 */
export const uiCopyConditions = [
  'NM',
  'LP',
  'MP',
  'HP',
  'DMG',
] as const satisfies readonly CopyCondition[];

/** One explicit correction of one physical copy; printing, finish and condition change together. */
export interface UiCopyCorrection {
  readonly copyId: string;
  /** Revision the view read the copy with; a copy that changed meanwhile conflicts. */
  readonly expectedRevision: number;
  readonly printingId: string;
  readonly finish: Finish;
  readonly condition: CopyCondition | null;
}

/** One private read of explicit copies: the authorized copies and references without one. */
export interface UiCopyRead {
  readonly copies: readonly PhysicalCopy[];
  /** Requested references this account has no copy for; an absent copy is not a failed read. */
  readonly missing: readonly string[];
}

/** Private copy access of the collection views. */
export interface UiCopyAccess {
  /** Input constraints and operation availability the collection views present. */
  readonly constraints: UserCardsConstraints;
  read(copyIds: readonly string[], signal?: AbortSignal): Promise<UiCopyRead>;
  /** The provider-owned correction the view presents once its outcome is established. */
  correct(
    input: UiCopyCorrection,
    signal?: AbortSignal,
  ): UserCardsOperation<'correctCopy', CopyChangeResult>;
}

/**
 * The private copy operations the collection views present. It is the narrow part of Application's
 * browser contract these views use, so a consumer depends only on the capabilities it presents
 * (docs/architecture.md#composition-and-replacement).
 */
export type UiCopyClient = Pick<
  UserCardsAccountOperations,
  'constraints' | 'readCopies' | 'correctCopy'
>;

/** Builds the copy access over the private contract Application supplies. */
export function createCopyAccess(userCards: UiCopyClient): UiCopyAccess {
  if (
    typeof userCards?.readCopies !== 'function' ||
    typeof userCards.correctCopy !== 'function' ||
    userCards.constraints === undefined
  ) {
    throw new TypeError('The collection views read and correct copies through UserCards.');
  }
  return {
    constraints: userCards.constraints,
    async read(copyIds, signal) {
      const result = await userCards.readCopies(copyIds, signal);
      return { copies: [...result.copies.values()], missing: [...result.missing] };
    },
    correct: (input, signal) => userCards.correctCopy(input, signal),
  };
}

/** Outcome of one copy correction as a form presents it. */
export interface UiCopyCorrectionOutcome {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  readonly message: string | null;
  /** The committed copy, or the copy a recovery read observed; null when it could not be read. */
  readonly copy: PhysicalCopy | null;
}

/**
 * Corrects one copy and reports what the component committed. A revision conflict and a definite
 * failure are reported as such; a lost response leaves the outcome unknown while a recovery read
 * supplies the current copy for review and revision-guarded retry.
 */
export async function correctCopy(
  access: UiCopyAccess,
  input: UiCopyCorrection,
  signal?: AbortSignal,
): Promise<UiCopyCorrectionOutcome> {
  const outcome = await access.correct(input, signal).observe();
  if (outcome.state === 'committed') {
    const copy = outcome.record.copies[0];
    if (copy === undefined) {
      // A change that reports no committed copy carries no receipt: the view recovers instead of
      // presenting it as saved (docs/application.md#interface).
      return recoverCorrection(access, input.copyId, signal);
    }
    return { status: 'committed', message: null, copy };
  }
  if (outcome.state === 'rejected') {
    return outcome.failure.code === 'conflict'
      ? {
          status: 'conflict',
          message: 'The copy changed since you read it. Reload it and review your change.',
          copy: null,
        }
      : {
          status: 'failed',
          message:
            outcome.failure.message === '' ? 'The change was not saved.' : outcome.failure.message,
          copy: null,
        };
  }
  return recoverCorrection(access, input.copyId, signal);
}

/**
 * Observes the copy after an uncertain correction without inferring the operation's outcome.
 * Another operation can advance the revision, produce matching attributes or remove the copy.
 * The read supplies current state for review; retry still quotes a revision.
 */
async function recoverCorrection(
  access: UiCopyAccess,
  copyId: string,
  signal?: AbortSignal,
): Promise<UiCopyCorrectionOutcome> {
  let copy: PhysicalCopy | null;
  try {
    const read = await access.read([copyId], signal);
    copy = read.copies[0] ?? null;
  } catch {
    return {
      status: 'unknown',
      message: 'The outcome is unknown. Reload the copy before retrying.',
      copy: null,
    };
  }
  return {
    status: 'unknown',
    message:
      copy === null
        ? 'The outcome is unknown. This copy is no longer in the collection.'
        : 'The outcome is unknown. Reload the copy before retrying.',
    copy,
  };
}

/** The change one bulk tool applies to every selected copy. */
export type UiCopyChange =
  { readonly finish: Finish } | { readonly condition: CopyCondition | null };

/**
 * One bulk tool over explicit selected copy identities. The tool reads the revision of every
 * selected copy itself, applies the change the page currently offers to each of them, and reports
 * the outcome of the whole selection; a selection that names another entry level, or copies that
 * cannot all be read, acts on nothing (docs/user-interface.md#browsing-and-organization).
 */
export function copyChangeTool(options: {
  readonly id: string;
  readonly label: string;
  readonly access: UiCopyAccess;
  /** The change the tool applies, read from the control the page presents at this moment. */
  change(): UiCopyChange | null;
  /** What the user must choose before the tool can act, reported when `change` names none. */
  readonly guidance: string;
}): CardListTool {
  return {
    id: options.id,
    label: options.label,
    tool: {
      invoke(request: CardListToolRequest): Promise<CardListOperationOutcome> {
        return applyCopyChange(options.access, request, options.change(), options.guidance);
      },
    },
  };
}

async function applyCopyChange(
  access: UiCopyAccess,
  request: CardListToolRequest,
  change: UiCopyChange | null,
  guidance: string,
): Promise<CardListOperationOutcome> {
  if (change === null) {
    return { status: 'failed', message: guidance };
  }
  const copyIds: string[] = [];
  for (const target of request.targets) {
    if (target.kind !== 'copy') {
      return { status: 'failed', message: 'Select physical copies to change them.' };
    }
    copyIds.push(target.copyId);
  }
  if (copyIds.length === 0) {
    return { status: 'failed', message: 'Select the physical copies to change.' };
  }
  let copies: readonly PhysicalCopy[];
  try {
    copies = await readCopies(access, copyIds, request.signal);
  } catch (cause) {
    return {
      status: 'failed',
      message: `The selected copies could not be read: ${readUiFailureMessage(cause, 'unknown failure')}`,
    };
  }
  const byId = new Map(copies.map((copy) => [copy.copyId, copy] as const));
  if (byId.size !== copyIds.length) {
    // A selection with a copy this account no longer holds acts on no part of it.
    return {
      status: 'failed',
      message: 'Some selected copies are no longer in the collection. Reload and select again.',
    };
  }
  const counts = { committed: 0, conflict: 0, failed: 0, unknown: 0 };
  for (const copyId of copyIds) {
    const copy = byId.get(copyId);
    if (copy === undefined) {
      continue;
    }
    const outcome = await correctCopy(
      access,
      { ...changeOf(copy, change), copyId, expectedRevision: copy.revision },
      request.signal,
    );
    counts[outcome.status] += 1;
  }
  return copyChangeOutcome(counts, copyIds.length);
}

/** The requested attributes of one copy: the change replaces one attribute of the read copy. */
function changeOf(
  copy: PhysicalCopy,
  change: UiCopyChange,
): Omit<UiCopyCorrection, 'copyId' | 'expectedRevision'> {
  return {
    printingId: copy.printingId,
    finish: 'finish' in change ? change.finish : copy.finish,
    condition: 'condition' in change ? change.condition : copy.condition,
  };
}

/** Outcome of one bulk change over the whole selection; partial work is never reported as saved. */
function copyChangeOutcome(
  counts: { committed: number; conflict: number; failed: number; unknown: number },
  total: number,
): CardListOperationOutcome {
  if (counts.unknown > 0) {
    return {
      status: 'unknown',
      message: `${counts.unknown} of ${total} copies have an unknown outcome. Reload them before retrying.`,
    };
  }
  if (counts.conflict > 0) {
    return {
      status: 'conflict',
      message: `${counts.conflict} of ${total} copies changed since they were read. Reload and review the change.`,
    };
  }
  if (counts.failed > 0) {
    return {
      status: 'failed',
      message:
        counts.committed === 0
          ? `${counts.failed} of ${total} copies were not saved. Review the change and retry.`
          : `${counts.failed} of ${total} copies were not saved; ${counts.committed} were saved.`,
    };
  }
  return { status: 'committed', message: `Saved ${total} ${total === 1 ? 'copy' : 'copies'}.` };
}

/** Reads explicit copies in the bounded batches one private read accepts. */
async function readCopies(
  access: UiCopyAccess,
  copyIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly PhysicalCopy[]> {
  const copies: PhysicalCopy[] = [];
  const batchSize = access.constraints.batch.references;
  for (let index = 0; index < copyIds.length; index += batchSize) {
    const batch = copyIds.slice(index, index + batchSize);
    const read = await access.read(batch, signal);
    copies.push(...read.copies);
    if (read.missing.length > 0) {
      return copies;
    }
  }
  return copies;
}
