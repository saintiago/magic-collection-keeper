/**
 * Component scope: the browser deployment composition (docs/user-interface.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The camera the capture view opens and the validation of the composition's inputs are exercised
 * with a controlled device; the sign-in page and the shell it is presented in are covered by the
 * packaged browser journey.
 */

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../../src/application/index.js';
import { createBrowserDeployment, createBrowserDevice } from '../../../src/ui/deployment.js';

const settings = {
  environment: 'test',
  apiBaseUrl: 'https://api.test.keeper.example',
  authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
  recognition: { cloudEnabled: false, computeBaseUrl: null },
  capabilities: { sourceImports: true },
} as const;

describe('browser device', () => {
  it('opens the environment camera and releases every stream it handed out', async () => {
    const stopped: string[] = [];
    const stream = {
      getTracks: () => [{ stop: () => stopped.push('front') }],
    } as unknown as MediaStream;
    const constraints: MediaStreamConstraints[] = [];
    const device = createBrowserDevice({
      media: {
        async getUserMedia(received) {
          constraints.push(received);
          return stream;
        },
      },
    });

    const camera = await device.openCamera?.();
    expect(camera?.stream).toBe(stream);
    expect(constraints).toEqual([{ video: { facingMode: 'environment' }, audio: false }]);
    camera?.close();
    expect(stopped).toEqual(['front']);

    await device.openCamera?.();
    device.release();
    expect(stopped).toEqual(['front', 'front']);
  });

  it('omits the camera of an environment that grants none', () => {
    const device = createBrowserDevice({ media: undefined });

    expect(device.openCamera).toBeUndefined();
    expect(() => device.release()).not.toThrow();
  });
});

describe('browser deployment construction', () => {
  it('rejects private settings before the shell is built', () => {
    expect(() =>
      createBrowserDeployment({
        root: null,
        settings: { ...settings, resources: { catalogDatabase: { secretArn: 'arn:aws:secret' } } },
      }),
    ).toThrow(ConfigurationError);
  });

  it('requires the element the shell renders into', () => {
    expect(() => createBrowserDeployment({ root: null, settings })).toThrow(TypeError);
  });
});
