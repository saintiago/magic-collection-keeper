/**
 * Device capability the UserInterface receives (docs/user-interface.md#interface,
 * docs/user-interface.md#capture-and-review).
 *
 * The deployment supplies the browser's device access; the shell keeps it available to the pages
 * that use it and releases its resources when the session ends. Frame acquisition and capture
 * controls stay with the capture pages. Pages can release during synchronous abort and dispose
 * handlers, before a replacement mounts. Calls after teardown do nothing, so late work cannot
 * interrupt the replacement. An active or tearing-down caller receives the provider's completion
 * or failure; shell-owned session cleanup handles failures on a best-effort basis.
 */
export interface UiDevice {
  /** Releases device resources the UserInterface holds, such as an open camera. */
  release(): void | Promise<void>;
}
