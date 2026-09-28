/**
 * Identities the Capture component composes for its bindings (docs/capture.md#interface).
 *
 * A pending-import identity and every capture inside it are opaque and unique, and a retry refers
 * to the recorded staging under the identity it was begun with instead of creating a second one.
 * The values stay bounded like every identifier UserCards accepts.
 */

import { CAPTURE_LIMITS } from './limits.js';

let serial = 0;

/** One bounded, unique identity of the given family, for example `capture-import` or `capture`. */
export function createCaptureIdentity(family: string): string {
  serial += 1;
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 8);
  return `${family}-${stamp}-${serial.toString(36)}-${noise}`.slice(
    0,
    CAPTURE_LIMITS.maxIdentityLength,
  );
}
