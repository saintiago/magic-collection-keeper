/**
 * Device capability of the browser deployment (docs/user-interface.md#interface,
 * docs/user-interface.md#capture-and-review).
 *
 * The deployment grants the camera the capture view opens and releases every stream it handed out
 * when the session ends; a browser without camera access omits the acquisition operation, so the
 * capture view reports that this environment cannot capture instead of failing unexpectedly.
 */

import type { UiCamera, UiDevice } from './device.js';

/** The camera surface the deployment reads from the browsing context. */
export interface BrowserMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface BrowserDeviceOptions {
  /** Camera access of this browser; absent when the environment has none. */
  readonly media?: BrowserMediaDevices | undefined;
  readonly constraints?: MediaStreamConstraints | undefined;
}

/** Camera the capture view opens by default: the environment-facing camera of a phone or tablet. */
const defaultConstraints: MediaStreamConstraints = {
  video: { facingMode: 'environment' },
  audio: false,
};

export function createBrowserDevice(options: BrowserDeviceOptions = {}): UiDevice {
  const media = options.media ?? globalThis.navigator?.mediaDevices;
  const constraints = options.constraints ?? defaultConstraints;
  const open = new Set<UiCamera>();
  const device: UiDevice = {
    release() {
      for (const camera of [...open]) {
        camera.close();
      }
    },
  };
  if (typeof media?.getUserMedia !== 'function') {
    return device;
  }
  device.openCamera = async (): Promise<UiCamera> => {
    const stream = await media.getUserMedia(constraints);
    const camera: UiCamera = {
      stream,
      close() {
        open.delete(camera);
        for (const track of stream.getTracks()) {
          track.stop();
        }
      },
    };
    open.add(camera);
    return camera;
  };
  return device;
}
