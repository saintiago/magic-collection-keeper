/**
 * Notice contract the shell provides to the pages it presents
 * (docs/ui/navigation.md#interface, docs/ui/navigation.md#error-notices).
 *
 * Navigation owns the floating presentation region of the shell and exposes it to Pages. A page
 * and the editors it composes report the operation and service failures they present under the
 * identity of the operation that produced them; Navigation owns presentation only. The reporting
 * view supplies the message and recovery action its provider's outcome established, field and row
 * validation stay beside the control that owns them, and reporting an identity again updates the
 * presented notice instead of duplicating it.
 */

/**
 * How one notice presents: `progress` shows a spinner while the reported work is ongoing, `status`
 * reports a settled state a retry can check without a spinner, and `error` reports a failure with
 * red styling and a textual indicator.
 */
export type UiNoticeSeverity = 'progress' | 'status' | 'error';

/** One recovery action a notice offers; the reporter owns what the action does. */
export interface UiNoticeAction {
  readonly label: string;
  run(): void;
}

/** One notice the shell presents, identified by the operation it reports. */
export interface UiNotice {
  /** Identity of the reported operation; reporting it again updates the presented notice. */
  readonly id: string;
  readonly severity: UiNoticeSeverity;
  /** User-facing text of the notice; only this text is rendered, so external values stay safe. */
  readonly message: string;
  /** Relevant recovery; page-supplied actions expire on departure while the notice text remains. */
  readonly action?: UiNoticeAction | null;
}

/**
 * Notice capability the shell supplies to the pages it presents. A page reports the operation and
 * service failures it presents and updates the notice of an operation it reports again; Navigation
 * owns the presentation. Dismissing an identity that is not presented is ignored.
 */
export interface UiNotices {
  /** Presents the notice of this identity, or updates the presented notice of the same identity. */
  show(notice: UiNotice): void;
  /** Removes the notice of one identity. */
  dismiss(id: string): void;
}

/**
 * Reports one service failure of a view's own read under the identity of the operation that
 * failed, so the failure stays visible as the shell's error notice after the view is left while
 * the view keeps presenting it beside its own retry control (docs/ui/navigation.md#error-notices).
 */
export function reportUiFailure(
  notices: UiNotices | undefined,
  id: string,
  message: string,
  action?: UiNoticeAction,
): void {
  notices?.show({ id, severity: 'error', message, action: action ?? null });
}
