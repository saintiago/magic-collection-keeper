/**
 * Device capability the UserInterface receives (docs/user-interface.md#interface,
 * docs/user-interface.md#capture-and-review).
 *
 * The deployment supplies the browser's device access; the shell keeps it available to the pages
 * that use it and releases its resources when the session ends. Frame acquisition and capture
 * controls stay with the capture pages.
 */
export interface UiDevice {
  /** Releases device resources the UserInterface holds, such as an open camera. */
  release(): void | Promise<void>;
}
