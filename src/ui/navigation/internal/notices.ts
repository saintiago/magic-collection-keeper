/**
 * Floating notices of the Navigation module (docs/ui/navigation.md#indexing-notice,
 * docs/ui/navigation.md#error-notices).
 *
 * Navigation owns the one floating presentation region of the shell: the indexing notice of the
 * presented account and the operation and service failures the pages report through the capability
 * they receive. A notice is identified by the operation it reports, so showing the same identity
 * again updates the presented notice instead of duplicating it, and the same presentation serves
 * progress and errors: an error notice is red and names its failure in text, so color alone never
 * carries the meaning.
 *
 * Notices never block the page behind them and never take focus: they render in a fixed corner of
 * the shell, announce their text politely, keep their explicit dismiss control, and offer the
 * recovery action their reporter supplied. A notice that no longer reports ongoing work stops its
 * spinner.
 */

import type { UiNotice, UiNotices } from '../../shared/notices.js';

export type {
  UiNotice,
  UiNoticeAction,
  UiNotices,
  UiNoticeSeverity,
} from '../../shared/notices.js';

/** The notice presentation of one shell. */
export interface UiNoticeHost extends UiNotices {
  /** Keeps notice text but drops recovery callbacks belonging to a departed page. */
  retireActions(ids: Iterable<string>): void;
  /** Removes every presented notice; the account the shell presented ended. */
  clear(): void;
  /** Releases the presentation region; the shell is closing. */
  dispose(): void;
}

/**
 * Styles of the floating region. The shell has no stylesheet of its own, so the presentation of a
 * notice defines itself: a fixed corner that covers no control, a visible border, and a spinner
 * that stops for readers who prefer reduced motion (the text always states the progress).
 */
const noticeStyles = `
.ui-notices {
  position: fixed;
  inset-block-end: 1rem;
  inset-inline-end: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-inline-size: 24rem;
  z-index: 1000;
}
.ui-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 2px solid #1d4ed8;
  border-radius: 0.5rem;
  background: #ffffff;
  color: #1e293b;
  padding: 0.75rem 1rem;
  box-shadow: 0 2px 8px rgb(15 23 42 / 0.25);
}
.ui-notice[data-ui-notice-severity='status'] {
  border-color: #b45309;
  color: #92400e;
}
.ui-notice[data-ui-notice-severity='error'] {
  border-color: #b91c1c;
  background: #fef2f2;
  color: #b91c1c;
}
.ui-notice-message {
  flex: 1 1 auto;
}
.ui-notice-mark {
  flex: 0 0 auto;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.ui-notice-spinner {
  flex: 0 0 auto;
  inline-size: 1rem;
  block-size: 1rem;
  border: 2px solid currentColor;
  border-block-start-color: transparent;
  border-radius: 50%;
  animation: ui-notice-spin 0.9s linear infinite;
}
@keyframes ui-notice-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ui-notice-spinner {
    animation: none;
  }
}
.ui-notice button {
  font: inherit;
}
`;

/** One presented notice: the notice reported now and the element presenting it. */
interface PresentedNotice {
  notice: UiNotice;
  readonly element: HTMLDivElement;
  readonly spinner: HTMLSpanElement;
  readonly mark: HTMLElement;
  readonly message: HTMLSpanElement;
  readonly action: HTMLButtonElement;
  readonly dismiss: HTMLButtonElement;
}

/** Creates the floating notice region of one shell, rendering it into `parent`. */
export function createNoticeHost(parent: Element): UiNoticeHost {
  const document = parent.ownerDocument;
  const style = document.createElement('style');
  style.textContent = noticeStyles;
  const region = document.createElement('div');
  region.className = 'ui-notices';
  region.dataset.uiNotices = '';
  region.append(style);
  parent.append(region);
  const presented = new Map<string, PresentedNotice>();

  return { show, dismiss, retireActions, clear, dispose };

  function retireActions(ids: Iterable<string>): void {
    for (const id of ids) {
      const current = presented.get(id);
      if (current !== undefined) {
        current.notice = { ...current.notice, action: null };
        paint(current);
      }
    }
  }

  function show(notice: UiNotice): void {
    const current = presented.get(notice.id);
    if (current === undefined) {
      const created = createPresented(notice);
      presented.set(notice.id, created);
      region.append(created.element);
      paint(created);
      return;
    }
    current.notice = notice;
    paint(current);
  }

  function dismiss(id: string): void {
    const current = presented.get(id);
    if (current === undefined) {
      return;
    }
    presented.delete(id);
    current.element.remove();
  }

  function clear(): void {
    for (const current of presented.values()) {
      current.element.remove();
    }
    presented.clear();
  }

  function dispose(): void {
    clear();
    region.remove();
  }

  /**
   * One notice element. Every part is created once and updated in place, so an update of the same
   * operation neither duplicates the notice nor drops the focus a keyboard user gave its controls.
   */
  function createPresented(notice: UiNotice): PresentedNotice {
    // Listeners keep only the identity, never the initial report's view-owned callback.
    const id = notice.id;
    const element = document.createElement('div');
    element.className = 'ui-notice';
    element.dataset.uiNotice = notice.id;
    // One polite live region per notice: its text is announced without interrupting the page, and
    // the controls stay reachable by keyboard.
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    const spinner = document.createElement('span');
    spinner.className = 'ui-notice-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const mark = document.createElement('strong');
    mark.className = 'ui-notice-mark';
    mark.textContent = 'Error:';
    const message = document.createElement('span');
    message.className = 'ui-notice-message';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'ui-notice-action';
    action.dataset.uiNoticeAction = '';
    action.addEventListener('click', () => {
      // The action of the notice reported now, never of a superseded update.
      presented.get(id)?.notice.action?.run();
    });
    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.className = 'ui-notice-dismiss';
    dismissButton.dataset.uiNoticeDismiss = '';
    dismissButton.textContent = 'Dismiss';
    dismissButton.addEventListener('click', () => {
      dismiss(id);
    });
    element.append(spinner, mark, message, action, dismissButton);
    return { notice, element, spinner, mark, message, action, dismiss: dismissButton };
  }

  /** Presents the notice one element currently reports. */
  function paint(current: PresentedNotice): void {
    const { notice } = current;
    current.element.dataset.uiNoticeSeverity = notice.severity;
    current.spinner.hidden = notice.severity !== 'progress';
    current.mark.hidden = notice.severity !== 'error';
    current.message.textContent = notice.message;
    const action = notice.action ?? null;
    current.action.hidden = action === null;
    if (action !== null) {
      current.action.textContent = action.label;
    }
  }
}
