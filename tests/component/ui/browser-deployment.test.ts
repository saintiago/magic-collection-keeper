/**
 * Component scope: the browser deployment composition (docs/user-interface.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The validation of the composition's inputs is exercised here; the camera the capture view opens
 * is exercised in tests/component/capture/bindings.test.ts and the sign-in page and the shell it is
 * presented in are covered by the packaged browser journey.
 */

import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../../src/application/index.js';
import { createBrowserDeployment } from '../../../src/ui/deployment.js';

const settings = {
  environment: 'test',
  apiBaseUrl: 'https://api.test.keeper.example',
  authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
  recognition: { cloudEnabled: false, computeBaseUrl: null },
  capabilities: { sourceImports: true },
} as const;

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
