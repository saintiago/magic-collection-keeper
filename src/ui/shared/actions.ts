/**
 * Action context shared by the presentation modules of the UserInterface
 * (docs/ui/architecture.md#modules-and-composition, docs/ui/card-views.md, docs/ui/editors.md).
 *
 * A list presents the advisory actions of its explicit selection, and the editor layer owns what
 * one action does: the request carries the selected target context the list observed, and the
 * outcome is the presentation vocabulary of a provider-owned operation. CardViews forwards the
 * user's intent through this contract without implementing an operation; Editors supplies the
 * implementation.
 */

import type { CardListTarget, CardListToolSelection } from '../../card-list/index.js';

/** One user action over explicit targets through the owning component's operation. */
export interface UiActionRequest {
  readonly targets: readonly CardListTarget[];
  readonly selection: CardListToolSelection;
  readonly signal: AbortSignal;
}

/**
 * Result of one tool invocation. Consumers present a saved outcome only for `committed`, keep
 * unsaved input after `conflict` and `failed`, and recover the recorded outcome of an `unknown`
 * one (docs/application.md#construction-and-request-boundary).
 */
export interface UiOperationOutcome {
  readonly status: 'committed' | 'conflict' | 'failed' | 'unknown';
  /** User-facing explanation, or null when no further explanation helps. */
  readonly message: string | null;
}

/** One tool a list presents for its explicit selection. */
export interface UiListAction {
  /** Stable id the entry's tool availability fragment reports. */
  readonly id: string;
  /** Label of the tool's control. */
  readonly label: string;
  /**
   * The owning component's operation. A rejection carries no receipt, so the editor reports its
   * outcome as unknown; a definite failure is the operation's own `failed` outcome.
   */
  readonly tool: {
    invoke(request: UiActionRequest): Promise<UiOperationOutcome>;
  };
}

/**
 * Forwards one user action to the editor-supplied tool and normalizes its outcome. A rejected
 * dispatch carries no receipt, so only the provider can recover its outcome
 * (docs/application.md#construction-and-request-boundary).
 */
export async function runAction(
  action: UiListAction,
  request: UiActionRequest,
): Promise<UiOperationOutcome> {
  try {
    const outcome = await action.tool.invoke(request);
    if (
      outcome === null ||
      typeof outcome !== 'object' ||
      !['committed', 'conflict', 'failed', 'unknown'].includes(outcome.status)
    ) {
      return { status: 'unknown', message: null };
    }
    return {
      status: outcome.status,
      message: typeof outcome.message === 'string' ? outcome.message : null,
    };
  } catch {
    return { status: 'unknown', message: null };
  }
}
