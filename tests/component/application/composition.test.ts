/**
 * Component scope: Application construction (docs/application.md#construction-and-request-boundary).
 * Construction validates the environment's settings and the compatibility of every supplied
 * implementation before the application serves anything, and the browser composition validates the
 * public settings before it reaches a transport.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ConfigurationError,
  createAuthenticatedRequest,
  createBrowserApplication,
  createCatalogClient,
  readPublicSettings,
  resolveApplicationConfiguration,
} from '../../../src/application/index.js';
import {
  createPostgresApplication,
  type ApplicationResources,
} from '../../../src/application/backend.js';

import { testConfiguration, testIdentityVerifier, testPrompt } from './harness.js';

function resources(): ApplicationResources {
  return {
    readSql: {
      async query() {
        return [];
      },
      async transaction(work) {
        return work({
          async query() {
            return [];
          },
        });
      },
    },
    searchSql: {
      async query() {
        return [];
      },
      async transaction(work) {
        return work({
          async query() {
            return [];
          },
        });
      },
    },
    writeSql: {
      async query() {
        return [];
      },
      async transaction(work) {
        return work({
          async query() {
            return [];
          },
        });
      },
    },
    catalogSynchronization: {
      sql: {
        async query() {
          return [];
        },
        async transaction(work) {
          return work({
            async query() {
              return [];
            },
          });
        },
      },
      snapshots: {
        async open() {
          return { sourceName: 'test', sourceVersion: '1', text: (async function* () {})() };
        },
      },
    },
    searchIndexing: null,
    deckSource: null,
  };
}

describe('application composition', () => {
  it('rejects an invalid configuration before constructing anything', () => {
    const configuration = testConfiguration();
    configuration.environment = 'staging';

    expect(() =>
      createPostgresApplication({
        configuration,
        identity: testIdentityVerifier(),
        resources: resources(),
      }),
    ).toThrow(ConfigurationError);
  });

  it('accepts its own resolved configuration', () => {
    const configuration = resolveApplicationConfiguration(testConfiguration());

    expect(resolveApplicationConfiguration(configuration)).toEqual(configuration);
  });

  it('accepts a configuration-only application and exposes only its public settings', () => {
    const application = createPostgresApplication({
      configuration: testConfiguration(),
      identity: testIdentityVerifier(),
      resources: resources(),
    });

    expect(application.settings).toEqual(
      readPublicSettings(resolveApplicationConfiguration(testConfiguration())),
    );
    expect(JSON.stringify(application.settings)).not.toContain('arn:aws');
  });

  it('requires an identity verifier and a diagnostics sink', () => {
    expect(() =>
      createPostgresApplication({
        configuration: testConfiguration(),
        identity: {} as never,
        resources: resources(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      createPostgresApplication({
        configuration: testConfiguration(),
        identity: testIdentityVerifier(),
        resources: resources(),
        diagnostics: {} as never,
      }),
    ).toThrow(TypeError);
  });

  it('requires the deployment executor and the catalog job implementations', () => {
    expect(() =>
      createPostgresApplication({
        configuration: testConfiguration(),
        identity: testIdentityVerifier(),
        resources: {} as ApplicationResources,
      }),
    ).toThrow(TypeError);

    const incomplete = resources() as unknown as Record<string, unknown>;
    incomplete['catalogSynchronization'] = undefined;
    expect(() =>
      createPostgresApplication({
        configuration: testConfiguration(),
        identity: testIdentityVerifier(),
        resources: incomplete as unknown as ApplicationResources,
      }),
    ).toThrow(TypeError);
  });

  it('uses the reader for public queries without exposing the private writer', async () => {
    const supplied = resources();
    const read = vi.spyOn(supplied.readSql, 'query');
    const write = vi.spyOn(supplied.writeSql, 'query');
    const application = createPostgresApplication({
      configuration: testConfiguration(),
      identity: testIdentityVerifier(),
      resources: supplied,
    });
    const response = await application.handle({
      method: 'POST',
      path: '/api/catalog/resolve',
      body: JSON.stringify({ references: [] }),
    });
    // The empty reader has no published revision; the request must fail, without trying the writer.
    expect(response.status).toBe(503);
    expect(read).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it('serves a runtime that holds no catalog writer credential and reports the job as unavailable', async () => {
    // The interactive deployment composes no synchronization, because it never receives the
    // Catalog writer secret (docs/application.md#configuration-and-lifecycle).
    const application = createPostgresApplication({
      configuration: testConfiguration(),
      identity: testIdentityVerifier(),
      resources: { ...resources(), catalogSynchronization: null },
    });

    const response = await application.handle({
      method: 'GET',
      path: '/api/card',
      query: { printing: 'printing-1' },
    });
    expect(response.status).toBe(503);
    await expect(application.synchronizeCatalog({ dataset: 'default_cards' })).rejects.toThrow(
      /does not run catalog synchronization/,
    );
  });

  it('serves a runtime that holds no Search writer credential and reports indexing as unavailable', async () => {
    // The interactive deployment composes no Search indexing, because it never receives the
    // projection writer secret or the provider publication credentials
    // (docs/application.md#interface, docs/data-architecture.md#access-and-deployment).
    const application = createPostgresApplication({
      configuration: testConfiguration(),
      identity: testIdentityVerifier(),
      resources: { ...resources(), searchIndexing: null },
    });

    await expect(application.indexSearch({ accounts: [] })).rejects.toThrow(
      /does not run Search indexing/,
    );
  });

  it('validates the browser transports at construction', () => {
    expect(() =>
      createAuthenticatedRequest({ baseUrl: 'not-a-url', token: () => 'token' }),
    ).toThrow(TypeError);
    expect(() =>
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: undefined as never,
      }),
    ).toThrow(TypeError);
    expect(() => createCatalogClient(undefined as never)).toThrow(TypeError);
    expect(() => createBrowserApplication({ settings: {}, prompt: testPrompt() })).toThrow(
      ConfigurationError,
    );
  });
});
