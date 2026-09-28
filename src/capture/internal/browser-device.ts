/**
 * Browser device implementation of the Capture component (docs/capture.md#internal-design).
 *
 * The deployment grants the camera this device opens; the device presents the granted stream on
 * its own surface for sampling, reads the bounded brightness signature that gates admission and
 * hands the Recognition contract a frame bounded to its image limit. Both the stream and the
 * frames stay transient: the device retains no image, and closing the camera stops every track it
 * handed out. A browsing environment without camera access omits the acquisition operation, so a
 * session reports that this deployment cannot capture instead of failing unexpectedly.
 */

import { RECOGNITION_LIMITS } from '../../recognition/index.js';

import type { CaptureCamera, CaptureDevice } from './contract.js';
import { CAPTURE_LIMITS } from './limits.js';

/** The camera surface the deployment reads from the browsing context. */
export interface BrowserMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

/**
 * Video surface a granted stream is presented on for frame and signature sampling. The deployment
 * supplies the browser's own video element; a test supplies a controlled surface instead.
 */
export interface CaptureVideoSurface {
  readonly videoWidth: number;
  readonly videoHeight: number;
  srcObject: MediaProvider | null;
  play(): Promise<void>;
  pause(): void;
}

export interface BrowserCaptureDeviceOptions {
  /** Camera access of this browser; absent when the environment has none. */
  readonly media?: BrowserMediaDevices | undefined;
  readonly constraints?: MediaStreamConstraints | undefined;
  /** Creates the sampling surface; defaults to a detached video element of this document. */
  readonly createSurface?: () => CaptureVideoSurface | null;
}

/** Camera the capture view opens by default: the environment-facing camera of a phone or tablet. */
const defaultConstraints: MediaStreamConstraints = {
  video: { facingMode: 'environment' },
  audio: false,
};

export function createBrowserCaptureDevice(
  options: BrowserCaptureDeviceOptions = {},
): CaptureDevice<HTMLCanvasElement> {
  const media = options.media ?? globalThis.navigator?.mediaDevices;
  const constraints = options.constraints ?? defaultConstraints;
  const createSurface = options.createSurface ?? browserVideoSurface;
  const open = new Set<CaptureCamera<HTMLCanvasElement>>();
  /** Bounded signature surface, reused because one sample never outlives its own tick. */
  let analysis: HTMLCanvasElement | null = null;
  const device: CaptureDevice<HTMLCanvasElement> = {
    release() {
      for (const camera of [...open]) {
        camera.close();
      }
    },
  };
  if (typeof media?.getUserMedia !== 'function') {
    return device;
  }
  device.openCamera = async (): Promise<CaptureCamera<HTMLCanvasElement>> => {
    const stream = await media.getUserMedia(constraints);
    const surface = createSurface();
    if (surface === null) {
      stopStream(stream);
      throw new Error('The deployment presents no surface for the camera stream.');
    }
    surface.srcObject = stream;
    try {
      await surface.play();
    } catch (cause) {
      surface.srcObject = null;
      stopStream(stream);
      throw new Error('the camera stream could not be presented', { cause });
    }
    const camera: CaptureCamera<HTMLCanvasElement> = {
      preview: { stream },
      sample: () => readSignature(surface, () => (analysis ??= createCanvas())),
      // A frame is read once per attempt and handed to inference, so it owns its own canvas and a
      // later read never rewrites the pixels an in-flight attempt still reads.
      read: () => readFrame(surface),
      close() {
        open.delete(camera);
        surface.pause();
        surface.srcObject = null;
        stopStream(stream);
      },
    };
    open.add(camera);
    return camera;
  };
  return device;
}

/** Detached video element of the browsing document; null when no document is reachable. */
function browserVideoSurface(): CaptureVideoSurface | null {
  const document = globalThis.document;
  if (document === undefined) {
    return null;
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  return video;
}

/** Samples the presented frame into a bounded brightness signature. */
function readSignature(
  surface: CaptureVideoSurface,
  canvas: () => HTMLCanvasElement | null,
): readonly number[] | null {
  if (surface.videoWidth === 0 || surface.videoHeight === 0) {
    return null;
  }
  const view = canvas();
  if (view === null) {
    return null;
  }
  view.width = CAPTURE_LIMITS.signature;
  view.height = CAPTURE_LIMITS.signature;
  const context = view.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    return null;
  }
  context.drawImage(surface as unknown as CanvasImageSource, 0, 0, view.width, view.height);
  const pixels = context.getImageData(0, 0, view.width, view.height).data;
  const signature: number[] = [];
  for (let index = 0; index < pixels.length; index += 4) {
    signature.push(
      ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0)) / 3,
    );
  }
  return signature;
}

/**
 * Reads the current frame, bounded to the image the Recognition contract accepts. The width is
 * scaled first and the height follows from the provider's limit, so both dimensions stay whole
 * numbers whose product can never exceed it, whatever the camera's aspect ratio
 * (docs/recognition.md#interface).
 */
function readFrame(surface: CaptureVideoSurface): HTMLCanvasElement | null {
  const width = surface.videoWidth;
  const height = surface.videoHeight;
  if (width < 1 || height < 1) {
    return null;
  }
  const frame = createCanvas();
  if (frame === null) {
    return null;
  }
  const bound = RECOGNITION_LIMITS.maxImagePixels;
  const scale = Math.min(1, Math.sqrt(bound / (width * height)));
  frame.width = Math.max(1, Math.floor(width * scale));
  frame.height = Math.max(1, Math.min(height, Math.floor(bound / frame.width)));
  const context = frame.getContext('2d');
  if (context === null) {
    return null;
  }
  context.drawImage(surface as unknown as CanvasImageSource, 0, 0, frame.width, frame.height);
  return frame;
}

function createCanvas(): HTMLCanvasElement | null {
  const document = globalThis.document;
  return document === undefined ? null : document.createElement('canvas');
}

/** Stops every track of one granted stream; releasing is safe to repeat. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
