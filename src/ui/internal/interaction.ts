/**
 * Explicit user input that takes the interaction over from an automatic restoration
 * (docs/user-interface.md#state-ownership-and-restoration).
 *
 * Restoration keeps the intended context while content is unavailable, and explicit user changes
 * supersede the affected state: the shell stops moving the scroll offset and focus of a history
 * entry the user is returning to, and a list stops applying the list-local scroll and focus of a
 * window it is still acquiring. Only input the user makes themselves counts, so a focus, scroll or
 * value set by a restoration stays unreported.
 */

/** One explicit user action, whatever control it reaches and whether or not the control handles it. */
export const uiInputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Reports every explicit user action of one browsing context until `signal` aborts. The events are
 * observed in the capture phase, so a control that handles them still reports the user's input.
 */
export function observeUiInput(
  browser: Window | null,
  report: () => void,
  signal: AbortSignal,
): void {
  if (browser === null) {
    return;
  }
  for (const event of uiInputEvents) {
    browser.addEventListener(event, report, { capture: true, passive: true, signal });
  }
}
