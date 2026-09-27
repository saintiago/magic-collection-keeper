/**
 * Component scope: Application configuration (docs/application.md#configuration-and-lifecycle).
 * One environment's settings are validated before any work starts, production settings require
 * https, a capability and its resource must agree, and the browser receives only public settings —
 * never resource ARNs, secret references, database or bucket names.
 */

import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  readPublicSettings,
  resolveApplicationConfiguration,
  resolvePublicSettings,
} from '../../../src/application/index.js';

import { testConfiguration } from './harness.js';

describe('application configuration', () => {
  it('resolves one explicit environment and exposes only its public settings', () => {
    const configuration = resolveApplicationConfiguration(testConfiguration());

    expect(configuration.environment).toBe('test');
    expect(Object.keys(readPublicSettings(configuration)).sort()).toEqual([
      'apiBaseUrl',
      'authentication',
      'capabilities',
      'environment',
      'recognition',
    ]);
    const settings = JSON.stringify(readPublicSettings(configuration));
    expect(settings).not.toContain('arn:aws');
    expect(settings).not.toContain('keeper-test-snapshots');
    expect(settings).not.toContain('keeper-test-db');
    expect(settings).not.toContain('cognito-idp');
  });

  it('keeps the environment and its identity explicit', () => {
    const development = testConfiguration();
    development.environment = 'development';
    development.authentication.issuer = 'https://cognito-idp.us-east-1.amazonaws.com/dev-pool';
    const production = testConfiguration();
    production.environment = 'production';
    production.authentication.issuer = 'https://cognito-idp.us-east-1.amazonaws.com/prod-pool';
    production.browser.apiBaseUrl = 'https://api.keeper.example';

    expect(resolveApplicationConfiguration(development).environment).toBe('development');
    expect(resolveApplicationConfiguration(production).environment).toBe('production');
    expect(resolveApplicationConfiguration(development).authentication.appClientId).toBe(
      resolveApplicationConfiguration(production).authentication.appClientId,
    );
  });

  it('rejects an unknown environment', () => {
    const configuration = testConfiguration();
    configuration.environment = 'staging';

    expect(() => resolveApplicationConfiguration(configuration)).toThrow(ConfigurationError);
    expect(problemPathsOf(configuration)).toContain('environment');
  });

  it('requires every resource and identity setting instead of defaulting to one', () => {
    const problems = problemPathsOf({});

    expect(problems).toEqual(
      expect.arrayContaining([
        'environment',
        'region',
        'browser',
        'resources',
        'authentication',
        'recognition',
        'capabilities',
        'transport',
      ]),
    );
  });

  it('rejects a resource setting that is not an AWS reference', () => {
    const configuration = testConfiguration();
    configuration.resources.catalogDatabase.secretArn = 'keeper-test-db';

    expect(problemPathsOf(configuration)).toContain('resources.catalogDatabase.secretArn');
  });

  it('requires production URLs to use https', () => {
    const configuration = testConfiguration();
    configuration.environment = 'production';
    configuration.browser.apiBaseUrl = 'http://api.keeper.example';
    configuration.authentication.issuer = 'http://cognito-idp.us-east-1.amazonaws.com/prod';

    const problems = problemPathsOf(configuration);
    expect(problems).toContain('browser.apiBaseUrl');
    expect(problems).toContain('authentication.issuer');
  });

  it('requires an enabled compute capability and its base URL to agree', () => {
    const missingUrl = testConfiguration();
    missingUrl.capabilities.cloudRecognition = true;
    expect(problemPathsOf(missingUrl)).toContain('recognition.computeBaseUrl');

    const unusedUrl = testConfiguration();
    unusedUrl.recognition.computeBaseUrl = 'https://compute.keeper.example';
    expect(problemPathsOf(unusedUrl)).toContain('recognition.computeBaseUrl');
  });

  it('bounds the request deadline', () => {
    const configuration = testConfiguration();
    configuration.transport.requestTimeoutMs = 0;
    expect(problemPathsOf(configuration)).toContain('transport.requestTimeoutMs');

    configuration.transport.requestTimeoutMs = 15 * 60 * 1000 + 1;
    expect(problemPathsOf(configuration)).toContain('transport.requestTimeoutMs');
  });

  it('reports no supplied value, credential or resource reference', () => {
    const configuration = testConfiguration() as unknown as Record<string, unknown>;
    configuration['transport'] = { requestTimeoutMs: 'super-secret-value' };

    const error = configurationErrorOf(configuration);
    expect(error.message).not.toContain('super-secret-value');
    expect(error.message).not.toContain('arn:aws');
  });

  it('rejects private settings beside the public ones', () => {
    const settings = readPublicSettings(resolveApplicationConfiguration(testConfiguration()));

    expect(resolvePublicSettings(settings)).toEqual(settings);
    expect(() =>
      resolvePublicSettings({
        ...settings,
        resources: { catalogDatabase: { secretArn: 'arn:aws:secretsmanager:secret' } },
      }),
    ).toThrow(ConfigurationError);
  });
});

/** The field location of every problem, without the rule description. */
function problemPathsOf(configuration: unknown): readonly string[] {
  return configurationErrorOf(configuration).problems.map((problem) => {
    const separator = problem.indexOf(':');
    return separator === -1 ? problem : problem.slice(0, separator);
  });
}

function configurationErrorOf(configuration: unknown): ConfigurationError {
  try {
    resolveApplicationConfiguration(configuration);
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      return cause;
    }
    throw cause;
  }
  throw new Error('Expected the configuration to be rejected.');
}
