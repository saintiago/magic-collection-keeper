/**
 * Operation presentation of the Editors module
 * (docs/ui/editors.md, docs/ui/architecture.md#modules-and-composition).
 *
 * An editor owns what one action of a presented list does: the action executes through its
 * provider-owned operation and reports the outcome the provider established. CardViews reports the
 * user's intent and the explicit targets it observed; the editor runs the matching action, keeps
 * the pending state while it is in flight and presents the authoritative outcome. Only a committed
 * outcome is reported as saved (docs/application.md#construction-and-request-boundary).
 */

import type { CardListToolSelection } from '../../../card-list/index.js';

/** One user action over the explicit targets a list reported. */
export interface UiActionRequest {
  /** Explicit selected targets the list observed; visible rows are not a substitute. */
  readonly selection: CardListToolSelection;
  /** Aborted when the editor closes or the presentation of the action is superseded. */
  readonly signal: AbortSignal;
}

/**
 * Result of one action. Editors present a saved outcome only for `committed`, keep unsaved input
 * after `conflict` and `failed`, and recover the recorded outcome of an `unknown` one
 * (docs/application.md#construction-and-request-boundary).
 */
export interface UiOperationOutcome {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  /** User-facing explanation, or null when no further explanation helps. */
  readonly message: string | null;
}

/** One editor-owned action a presented list names. */
export interface UiOperationAction<Outcome extends UiOperationOutcome = UiOperationOutcome> {
  readonly id: string;
  readonly label: string;
  /** Runs the operation over the explicit selection; a rejection carries no receipt. */
  apply(request: UiActionRequest): Promise<Outcome>;
}

/**
 * Runs one editor-owned action and normalizes the outcome it reported. A rejected dispatch carries
 * no receipt, and a result outside the operation vocabulary establishes nothing, so only the
 * provider can recover such an outcome (docs/application.md#construction-and-request-boundary).
 */
export async function applyAction<Outcome extends UiOperationOutcome>(
  action: UiOperationAction<Outcome>,
  request: UiActionRequest,
): Promise<Outcome> {
  try {
    const reported: unknown = await action.apply(request);
    if (reported === null || typeof reported !== 'object') {
      return unknownOutcome();
    }
    const outcome = reported as { readonly status?: unknown; readonly message?: unknown };
    if (!readStatus(outcome.status)) {
      return unknownOutcome();
    }
    // The action may report further fields beside the outcome (a batch count, for example); the
    // presentation reads the checked status and message and keeps the rest untouched.
    return {
      ...reported,
      status: outcome.status,
      message: typeof outcome.message === 'string' ? outcome.message : null,
    } as Outcome;
  } catch {
    return unknownOutcome();
  }
}

/** One outcome that establishes nothing. */
function unknownOutcome<Outcome extends UiOperationOutcome>(): Outcome {
  return { status: 'unknown', message: null } as Outcome;
}

/** Whether one reported value is an operation outcome status. */
function readStatus(value: unknown): value is UiOperationOutcome['status'] {
  return (
    typeof value === 'string' && ['committed', 'conflict', 'failed', 'unknown'].includes(value)
  );
}

/** Human text of one operation outcome, used when the outcome carries no message of its own. */
export function outcomeText(status: UiOperationOutcome['status']): string {
  switch (status) {
    case 'committed':
      return 'Saved.';
    case 'conflict':
      return 'The change conflicts with a newer version; review and retry.';
    case 'failed':
      return 'The action failed. Please retry.';
    case 'unknown':
      return 'The outcome is unknown; recover the recorded operation outcome.';
  }
}
