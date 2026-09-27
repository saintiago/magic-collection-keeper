/**
 * Device capability the UserInterface receives (docs/user-interface.md#interface,
 * docs/user-interface.md#capture-and-review).
 *
 * The deployment supplies the browser's device access; the shell keeps it available to the pages
 * that use it and releases its resources when the session ends. Frame acquisition, capture
 * controls and the admission decision stay with the capture pages; the camera the deployment
 * grants is the raw material they read frames from, and the capture page closes it when its
 * session ends. A deployment without a camera omits the acquisition operation, and the capture
 * view reports that it cannot capture in this environment. Pages can open, close and release
 * during synchronous abort and dispose handlers, before a replacement mounts. Calls after teardown
 * do nothing, so late work cannot interrupt the replacement. An active or tearing-down caller
 * receives the provider's completion or failure; shell-owned session cleanup handles failures on a
 * best-effort basis.
 */

/**
 * One open camera of the deployment's device. The capture page presents the stream, reads frames
 * from it and closes the camera when the session ends; a closed camera stops delivering frames.
 */
export interface UiCamera {
  /** Live video of the granted camera, presented by the capture view. */
  readonly stream: MediaStream;
  /** Stops this camera and releases its resources; safe to call more than once. */
  close(): void;
}

export interface UiDevice {
  /**
   * Requests the deployment's camera as the capture view uses it. Absent when the deployment holds
   * no camera. A refused permission or an unavailable camera rejects with the deployment's
   * failure, which the capture view reports without retrying by itself.
   */
  openCamera?(): Promise<UiCamera>;
  /** Releases device resources the UserInterface holds, such as an open camera. */
  release(): void | Promise<void>;
}
