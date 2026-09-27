/**
 * Copy editing of the collection views (docs/user-interface.md#browsing-and-organization,
 * docs/user-cards.md#records-and-associations).
 *
 * The collection and card-details views correct physical copies through the private UserCards
 * contract Application supplies. One correction quotes the revision the view read, so a copy that
 * changed meanwhile conflicts instead of being overwritten, and a correction that cannot be
 * confirmed — a lost response or a busy service — is recovered from the copy's recorded state
 * instead of being reported as saved or failed: the read either shows the requested attributes,
 * which is the committed change, or shows other attributes, which means the change was not
 * applied. A bulk change names every selected copy explicitly, reads each copy's revision itself
 * and reports the counts it actually committed; a partial change is never reported as success
 * (docs/user-interface.md#browsing-and-organization, docs/application.md#interface).
 */

import type { UserCardsClient } from '../../application/index.js';
import type { Finish } from '../../catalog/index.js';
import type { CopyCondition, PhysicalCopy } from '../../usercards/index.js';

import type { UiCardListTool } from './card-list.js';
import { UI_LIMITS } from './limits.js';
import type { UiOperationOutcome, UiToolRequest } from './list.js';

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
  read(copyIds: readonly string[], signal?: AbortSignal): Promise<UiCopyRead>;
  correct(input: UiCopyCorrection, signal?: AbortSignal): Promise<PhysicalCopy>;
}

/** Builds the copy access over the private contract Application supplies. */
export function createCopyAccess(userCards: UserCardsClient): UiCopyAccess {
  if (typeof userCards?.readCopies !== 'function' || typeof userCards.correctCopy !== 'function') {
    throw new TypeError('The collection views read and correct copies through UserCards.');
  }
  return {
    async read(copyIds, signal) {
      const result = await userCards.readCopies(copyIds, signal);
      return { copies: [...result.copies.values()], missing: [...result.missing] };
    },
    async correct(input, signal) {
      const result = await userCards.correctCopy(input, signal);
      const copy = result.copies[0];
      if (copy === undefined) {
        // A change that reports no committed copy carries no receipt: the caller recovers instead
        // of presenting it as saved (docs/application.md#interface).
        throw new Error('The corrected copy was not returned.');
      }
      return copy;
    },
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
 * failure are reported as such; a response that was lost on its way back is recovered from the
 * copy's recorded state, whose revision the committed change advanced.
 */
export async function correctCopy(
  access: UiCopyAccess,
  input: UiCopyCorrection,
  signal?: AbortSignal,
): Promise<UiCopyCorrectionOutcome> {
  try {
    return { status: 'committed', message: null, copy: await access.correct(input, signal) };
  } catch (cause) {
    const code = readFailureCode(cause);
    if (code === 'conflict') {
      return {
        status: 'conflict',
        message: 'The copy changed since you read it. Reload it and review your change.',
        copy: null,
      };
    }
    if (code !== null && isDefiniteFailure(code)) {
      return {
        status: 'failed',
        message: readMessage(cause, 'The change was not saved.'),
        copy: null,
      };
    }
    // The operation may have committed before its answer went missing: the copy's recorded state
    // decides the outcome instead of an assumption (docs/application.md#interface).
    try {
      const read = await access.read([input.copyId], signal);
      const copy = read.copies[0] ?? null;
      if (copy !== null && matchesCorrection(copy, input)) {
        return { status: 'committed', message: null, copy };
      }
      return {
        status: 'failed',
        message: 'The change was not saved. Review it and retry.',
        copy,
      };
    } catch {
      return {
        status: 'unknown',
        message: 'The outcome is unknown. Reload the copy before retrying.',
        copy: null,
      };
    }
  }
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
}): UiCardListTool {
  return {
    id: options.id,
    label: options.label,
    tool: {
      invoke(request: UiToolRequest): Promise<UiOperationOutcome> {
        return applyCopyChange(options.access, request, options.change(), options.guidance);
      },
    },
  };
}

async function applyCopyChange(
  access: UiCopyAccess,
  request: UiToolRequest,
  change: UiCopyChange | null,
  guidance: string,
): Promise<UiOperationOutcome> {
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
      message: `The selected copies could not be read: ${readMessage(cause, 'unknown failure')}`,
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
): UiOperationOutcome {
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
  for (let index = 0; index < copyIds.length; index += UI_LIMITS.copyBatch) {
    const batch = copyIds.slice(index, index + UI_LIMITS.copyBatch);
    const read = await access.read(batch, signal);
    copies.push(...read.copies);
    if (read.missing.length > 0) {
      return copies;
    }
  }
  return copies;
}

/** Whether one recovered copy already carries the requested attributes. */
function matchesCorrection(copy: PhysicalCopy, input: UiCopyCorrection): boolean {
  return (
    copy.printingId === input.printingId &&
    copy.finish === input.finish &&
    copy.condition === input.condition
  );
}

/**
 * Failure codes that establish the change was not applied: the request never reached a commit, so
 * the view reports a definite failure instead of recovering a recorded outcome.
 */
function isDefiniteFailure(code: string): boolean {
  return (
    code === 'invalid-request' ||
    code === 'not-found' ||
    code === 'unauthorized' ||
    code === 'cancelled'
  );
}

/** Failure code of one rejected operation, or null when the cause carries none. */
function readFailureCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) {
    return null;
  }
  const code = Reflect.get(cause, 'code');
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
