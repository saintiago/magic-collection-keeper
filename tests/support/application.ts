/**
 * Application test fixtures: one valid environment configuration and the verified claims of one
 * caller, shared by the component and integration cases so both exercise the same environment.
 */

import {
  createClaimsIdentityVerifier,
  type IdentityVerifier,
} from '../../src/application/index.js';
import type { CatalogRevision } from '../../src/catalog/index.js';

export const testIssuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_keeper';
export const testAppClientId = 'keeper-test-client';
export const testAccount = 'cognito-alice';

export const testRevision: CatalogRevision = {
  revisionId: 'catalog-revision-1',
  sourceName: 'scryfall',
  sourceVersion: '2026-09-01T00:00:00.000Z',
  publishedAt: '2026-09-01T00:00:00.000Z',
};

/** One mutable raw configuration of the test environment. */
export interface TestConfiguration {
  environment: string;
  region: string;
  browser: { apiBaseUrl: string };
  resources: {
    catalogDatabase: { resourceArn: string; secretArn: string; database: string };
    userCardsReadDatabase: { resourceArn: string; secretArn: string; database: string };
    userCardsWriteDatabase: { resourceArn: string; secretArn: string; database: string };
    catalogSnapshots: { bucket: string; prefix: string | null };
  };
  authentication: { issuer: string; appClientId: string; region: string };
  recognition: { computeBaseUrl: string | null };
  capabilities: { cloudRecognition: boolean; sourceImports: boolean };
  transport: { requestTimeoutMs: number };
}

/** A fresh valid configuration; every case mutates only the field it exercises. */
export function testConfiguration(): TestConfiguration {
  return {
    environment: 'test',
    region: 'us-east-1',
    browser: { apiBaseUrl: 'https://api.test.keeper.example' },
    resources: {
      catalogDatabase: {
        resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-test-db',
        database: 'keeper',
      },
      userCardsReadDatabase: {
        resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-test-search',
        database: 'keeper',
      },
      userCardsWriteDatabase: {
        resourceArn: 'arn:aws:rds:us-east-1:123456789012:cluster:keeper-test',
        secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keeper-test-db',
        database: 'keeper',
      },
      catalogSnapshots: { bucket: 'keeper-test-snapshots', prefix: null },
    },
    authentication: {
      issuer: testIssuer,
      appClientId: testAppClientId,
      region: 'us-east-1',
    },
    recognition: { computeBaseUrl: null },
    capabilities: { cloudRecognition: false, sourceImports: true },
    transport: { requestTimeoutMs: 5_000 },
  };
}

/** The claims of one verified caller of the test environment. */
export function claimsFor(
  accountId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    iss: testIssuer,
    aud: testAppClientId,
    sub: accountId,
    token_use: 'id',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

/** The verifier the test environment's production wiring selects. */
export function testIdentityVerifier(): IdentityVerifier {
  return createClaimsIdentityVerifier({
    issuer: testIssuer,
    appClientId: testAppClientId,
  });
}
