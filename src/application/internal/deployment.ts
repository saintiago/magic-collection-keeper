/** Legacy combined serving runtime retained for compatibility and tests. */

import { RDSDataClient } from '@aws-sdk/client-rds-data';
import { z } from 'zod';

import type { Application } from './application.js';
import { createDataApiTransactor, createRdsDataApiClient, type DataApiClient } from './data-api.js';
import {
  ConfigurationError,
  resolveApplicationConfiguration,
  type ApplicationConfiguration,
} from './configuration.js';
import type { Diagnostics } from './diagnostics.js';
import { createClaimsIdentityVerifier } from './identity.js';
import { createPostgresApplication } from './postgres-composition.js';
import {
  destroyClient,
  optionalVariable,
  readRuntimeIdentity,
  requiredVariable,
} from './deployment-environment.js';

export type {
  DataApiClient,
  DataApiCommand,
  DataApiCommandName,
  DeploymentSqlExecutor,
  DeploymentSqlRow,
  DeploymentSqlTransactor,
  DeploymentSqlValue,
} from './data-api.js';
export { createDataApiTransactor, createRdsDataApiClient } from './data-api.js';
export {
  createApiGatewayHandler,
  createConsoleDiagnostics,
  type ApiGatewayHttpApiEvent,
  type LambdaHttpResponse,
} from './lambda-deployment.js';

const userPoolIdSchema = z
  .string()
  .regex(/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}$/, 'Use a Cognito user pool identifier.');
const requestTimeoutSchema = z.string().regex(/^\d+$/, 'Use a whole number of milliseconds.');

/**
 * Reads the interactive runtime's settings from the variables infra/README.md documents. Every
 * required variable is named when it is missing, and the assembled configuration is validated
 * before any component is constructed.
 */
export function readInteractiveEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ApplicationConfiguration {
  const runtime = readRuntimeIdentity(environment);
  const region = runtime.region;
  const clusterArn = requiredVariable(environment, 'KEEPER_DATABASE_CLUSTER_ARN');
  const database = requiredVariable(environment, 'KEEPER_DATABASE_NAME');
  const catalogReaderSecretArn = requiredVariable(
    environment,
    'KEEPER_DATABASE_CATALOG_READER_SECRET_ARN',
  );
  const userCardsReaderSecretArn = requiredVariable(
    environment,
    'KEEPER_DATABASE_USERCARDS_READER_SECRET_ARN',
  );
  const userCardsWriterSecretArn = requiredVariable(
    environment,
    'KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN',
  );
  const poolId = userPoolIdSchema.safeParse(requiredVariable(environment, 'KEEPER_USER_POOL_ID'));
  if (!poolId.success) {
    throw new ConfigurationError([
      `KEEPER_USER_POOL_ID: ${poolId.error.issues[0]?.message ?? 'Use a Cognito user pool identifier.'}`,
    ]);
  }
  const apiBaseUrl = requiredVariable(environment, 'KEEPER_RECOGNITION_BASE_URL');
  const cloudRecognition = booleanVariable(environment, 'KEEPER_CLOUD_RECOGNITION');
  const requestTimeoutMs = requestTimeoutSchema.safeParse(
    requiredVariable(environment, 'KEEPER_REQUEST_TIMEOUT_MS'),
  );
  if (!requestTimeoutMs.success) {
    throw new ConfigurationError([
      `KEEPER_REQUEST_TIMEOUT_MS: ${requestTimeoutMs.error.issues[0]?.message ?? 'Use a whole number of milliseconds.'}`,
    ]);
  }
  return resolveApplicationConfiguration({
    environment: runtime.environment,
    region,
    browser: { apiBaseUrl },
    resources: {
      catalogDatabase: { resourceArn: clusterArn, secretArn: catalogReaderSecretArn, database },
      userCardsReadDatabase: {
        resourceArn: clusterArn,
        secretArn: userCardsReaderSecretArn,
        database,
      },
      userCardsWriteDatabase: {
        resourceArn: clusterArn,
        secretArn: userCardsWriterSecretArn,
        database,
      },
      catalogSnapshots: {
        bucket: requiredVariable(environment, 'KEEPER_SNAPSHOT_BUCKET'),
        prefix: optionalVariable(environment, 'KEEPER_SNAPSHOT_PREFIX'),
      },
    },
    authentication: {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId.data}`,
      appClientId: requiredVariable(environment, 'KEEPER_USER_POOL_CLIENT_ID'),
      region,
    },
    recognition: { computeBaseUrl: cloudRecognition ? apiBaseUrl : null },
    capabilities: {
      cloudRecognition,
      sourceImports: booleanVariable(environment, 'KEEPER_SOURCE_IMPORTS'),
    },
    transport: { requestTimeoutMs: Number(requestTimeoutMs.data) },
  });
}

function booleanVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = requiredVariable(environment, name);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ConfigurationError([`${name}: use true or false.`]);
}

export interface InteractiveDeploymentOptions {
  /** Environment of this runtime, for example `process.env`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Data API client to use; tests supply their own, the runtime constructs the SDK client. */
  readonly dataApi?: DataApiClient;
  readonly diagnostics?: Diagnostics;
}

export interface InteractiveDeployment {
  readonly application: Application;
  readonly configuration: ApplicationConfiguration;
  /** Releases the runtime's reusable clients; the request boundary stops accepting work. */
  dispose(): void;
}

/** Composes distinct Catalog and UserCards query readers with the private operation writer. */
export function createInteractiveDeployment(
  options: InteractiveDeploymentOptions,
): InteractiveDeployment {
  const configuration = readInteractiveEnvironment(options?.environment);
  const owned = options.dataApi === undefined;
  const client =
    options.dataApi ?? createRdsDataApiClient(new RDSDataClient({ region: configuration.region }));
  const resources = configuration.resources;
  const application = createPostgresApplication({
    configuration,
    identity: createClaimsIdentityVerifier({
      issuer: configuration.authentication.issuer,
      appClientId: configuration.authentication.appClientId,
    }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    resources: {
      catalogReadSql: createDataApiTransactor({
        client,
        resourceArn: resources.catalogDatabase.resourceArn,
        secretArn: resources.catalogDatabase.secretArn,
        database: resources.catalogDatabase.database,
      }),
      userCardsReadSql: createDataApiTransactor({
        client,
        resourceArn: resources.userCardsReadDatabase.resourceArn,
        secretArn: resources.userCardsReadDatabase.secretArn,
        database: resources.userCardsReadDatabase.database,
      }),
      writeSql: createDataApiTransactor({
        client,
        resourceArn: resources.userCardsWriteDatabase.resourceArn,
        secretArn: resources.userCardsWriteDatabase.secretArn,
        database: resources.userCardsWriteDatabase.database,
      }),
      // The interactive runtime holds no Catalog writer credential and runs no synchronization.
      catalogSynchronization: null,
      deckSource: null,
    },
  });
  return {
    application,
    configuration,
    dispose() {
      application.dispose();
      if (owned) {
        destroyClient(client);
      }
    },
  };
}
