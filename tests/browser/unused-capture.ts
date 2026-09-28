/**
 * The Capture capability a journey supplies when its pages present no camera
 * (docs/capture.md#interface, docs/user-interface.md#capture-and-review).
 *
 * Application composes the capability for every deployment, so a harness that replaces the
 * boundaries around the shell still hands its pages the factory. The session itself is only
 * created by a mounted capture view, and a page without a camera reports that instead of opening
 * one.
 */

import { createCaptureBrowser, type CaptureBrowser } from '../../src/capture/index.js';
import { recognitionEngineNames } from '../../src/recognition/index.js';
import type { UserCardsOperations } from '../../src/usercards/browser.js';

export function unusedCapture(userCards: UserCardsOperations): CaptureBrowser {
  return createCaptureBrowser({
    userCards,
    engines: recognitionEngineNames(false),
    createRecognition: () => {
      throw new Error('This journey presents no camera and runs no recognition.');
    },
  });
}
