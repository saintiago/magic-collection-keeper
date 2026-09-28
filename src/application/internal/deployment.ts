/**
 * Deployment composition of the packaged runtimes
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * One runtime receives its settings as explicit environment variables and validates them before it
 * constructs anything, so a development, test or production deployment never inherits another
 * environment's identity or storage. The interactive entry point binds the reader credential and
 * the UserCards writer credential to the same Aurora cluster; the finite catalog job binds only the
 * Catalog writer credential and the private snapshot bucket. Neither runtime names the other
 * component's writer secret, so the database roles enforce the documented write boundary even when
 * a runtime is misconfigured (infra/README.md).
 *
 * The AWS SDK stays behind two narrow ports. {@link DataApiClient} issues RDS Data API calls and
 * {@link SnapshotObjectClient} reads snapshot objects, so the composition is exercised locally
 * against the same call shapes a deployed runtime uses. Only this module selects the concrete SDK
 * clients; the component contracts it satisfies stay provider-owned.
 */

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  createCatalogSynchronizer,
  type CatalogRevision,
  type CatalogSnapshot,
  type CatalogSnapshotSource,
  type CatalogSynchronizationRequest,
} from '../../catalog/index.js';

import type { Application } from './application.js';
import {
  ConfigurationError,
  resolveApplicationConfiguration,
  type ApplicationConfiguration,
} from './configuration.js';
import type { Diagnostics } from './diagnostics.js';
import { createClaimsIdentityVerifier } from './identity.js';
import { createPostgresApplication } from './postgres-composition.js';
import {
  ApplicationError,
  isApplicationFailureCode,
  type ApplicationFailureCode,
} from './failures.js';
import { failureResponse, type TransportRequest, type TransportResponse } from './transport.js';

/** Provider dataset the finite catalog job ingests; the configured source maps it to one object. */
export const CATALOG_JOB_DATASET = 'default_cards';

/** Provider name every snapshot of the deployed source reports (docs/catalog.md#synchronization). */
export const CATALOG_SNAPSHOT_SOURCE_NAME = 'scryfall';

/** Object metadata key that carries the provider's version of one snapshot object. */
export const SNAPSHOT_VERSION_METADATA_KEY = 'source-version';

/**
 * Diagnostics sink of a deployed runtime: one JSON record per operation, carrying the operation,
 * its request identity, its outcome, the failure code and the duration — never a request body,
 * credential, image or private record content. The container and function runtimes write the
 * record to their own CloudWatch log group.
 */
export function createConsoleDiagnostics(
  write: (line: string) => void = (line) => console.info(line),
): Diagnostics {
  return {
    record(event) {
      write(JSON.stringify({ event: 'keeper-operation', ...event }));
    },
  };
}

/** One scalar value the deployment's SQL transports carry; the Data API rejects arrays. */
export type DeploymentSqlValue = string | number | boolean | null;

export type DeploymentSqlRow = Readonly<Record<string, DeploymentSqlValue>>;

export interface DeploymentSqlExecutor {
  query(
    statement: string,
    parameters?: Readonly<Record<string, DeploymentSqlValue>>,
  ): Promise<readonly DeploymentSqlRow[]>;
}

/**
 * Transaction-capable executor of one deployed runtime. It satisfies the provider-owned executor
 * contracts Catalog, Search and UserCards declare: a transaction begins, commits or rolls back
 * through the RDS Data API, and the statements handed to the work run inside it only.
 */
export interface DeploymentSqlTransactor extends DeploymentSqlExecutor {
  transaction<T>(work: (statements: DeploymentSqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * RDS Data API calls the composition issues. The port is deliberately small: one call carries one
 * statement or one transaction control and returns the service's response fields.
 */
export type DataApiCommandName =
  'ExecuteStatement' | 'BeginTransaction' | 'CommitTransaction' | 'RollbackTransaction';

export interface DataApiCommand {
  readonly name: DataApiCommandName;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface DataApiClient {
  send(command: DataApiCommand): Promise<Readonly<Record<string, unknown>>>;
  /**
   * Releases the SDK client an adapter owns. A runtime that constructed its adapter calls this when
   * its work ends; a client a caller supplied without it stays open and stays the caller's.
   */
  destroy?(): void;
}

/** Head and body reads of the private snapshot bucket. */
export type SnapshotObjectCommandName = 'HeadObject' | 'GetObject';

export interface SnapshotObjectCommand {
  readonly name: SnapshotObjectCommandName;
  readonly input: {
    readonly Bucket: string;
    readonly Key: string;
    /** Exact object version to read; the source pins the body to the metadata it read. */
    readonly VersionId?: string;
  };
}

export interface SnapshotObject {
  /** Object metadata as S3 reported it. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Decoded object body, streamed in arbitrary chunks. */
  readonly body: AsyncIterable<string>;
  /** Version of the object this body belongs to, or null when the bucket reports none. */
  readonly version: string | null;
}

export interface SnapshotObjectClient {
  head(command: SnapshotObjectCommand): Promise<SnapshotObjectHandle>;
  get(command: SnapshotObjectCommand): Promise<SnapshotObject>;
  /** Releases the SDK client an adapter owns, exactly like {@link DataApiClient.destroy}. */
  destroy?(): void;
}

export interface SnapshotObjectHandle {
  readonly metadata: Readonly<Record<string, string>>;
  /** Version of the object these metadata describe, or null when the bucket reports none. */
  readonly version: string | null;
}

/** Coordinates of the one database a runtime reaches through the RDS Data API. */
export interface DeploymentDatabaseSettings {
  readonly clusterArn: string;
  readonly secretArn: string;
  readonly database: string;
}

/** Settings the finite catalog job reads; it holds no identity or browser setting. */
export interface CatalogJobConfiguration {
  readonly environment: string;
  readonly region: string;
  readonly database: DeploymentDatabaseSettings;
  readonly snapshots: {
    readonly bucket: string;
    readonly prefix: string | null;
  };
}

const environmentSchema = z.enum(['development', 'test', 'production']);
const regionSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, 'Use an AWS region such as us-east-1.');
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
  const readerSecretArn = requiredVariable(environment, 'KEEPER_DATABASE_READER_SECRET_ARN');
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
      catalogDatabase: { resourceArn: clusterArn, secretArn: readerSecretArn, database },
      userCardsDatabase: {
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

/** Reads the finite catalog job's settings; the job needs no identity, browser or route setting. */
export function readCatalogJobEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): CatalogJobConfiguration {
  const runtime = readRuntimeIdentity(environment);
  const database: DeploymentDatabaseSettings = {
    clusterArn: requiredVariable(environment, 'KEEPER_DATABASE_CLUSTER_ARN'),
    secretArn: requiredVariable(environment, 'KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN'),
    database: requiredVariable(environment, 'KEEPER_DATABASE_NAME'),
  };
  return {
    environment: runtime.environment,
    region: runtime.region,
    database,
    snapshots: {
      bucket: requiredVariable(environment, 'KEEPER_SNAPSHOT_BUCKET'),
      prefix: optionalVariable(environment, 'KEEPER_SNAPSHOT_PREFIX'),
    },
  };
}

function readRuntimeIdentity(environment: Readonly<Record<string, string | undefined>>): {
  readonly environment: z.infer<typeof environmentSchema>;
  readonly region: string;
} {
  const problem = environmentSchema.safeParse(requiredVariable(environment, 'KEEPER_ENVIRONMENT'));
  if (!problem.success) {
    throw new ConfigurationError(['KEEPER_ENVIRONMENT: use development, test or production.']);
  }
  const region = regionSchema.safeParse(requiredVariable(environment, 'AWS_REGION'));
  if (!region.success) {
    throw new ConfigurationError([
      `AWS_REGION: ${region.error.issues[0]?.message ?? 'Use an AWS region such as us-east-1.'}`,
    ]);
  }
  return { environment: problem.data, region: region.data };
}

function requiredVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError([`${name}: this runtime requires the variable.`]);
  }
  return value;
}

function optionalVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
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

/** Adapts the AWS RDS Data API client to the port this composition issues calls through. */
export function createRdsDataApiClient(client: RDSDataClient): DataApiClient {
  if (typeof client?.send !== 'function') {
    throw new TypeError('createRdsDataApiClient requires an RDS Data API client.');
  }
  return {
    async send(command): Promise<Readonly<Record<string, unknown>>> {
      switch (command.name) {
        case 'ExecuteStatement':
          return (await client.send(
            new ExecuteStatementCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'BeginTransaction':
          return (await client.send(
            new BeginTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'CommitTransaction':
          return (await client.send(
            new CommitTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
        case 'RollbackTransaction':
          return (await client.send(
            new RollbackTransactionCommand(command.input as never),
          )) as unknown as Readonly<Record<string, unknown>>;
      }
    },
    destroy() {
      destroyClient(client);
    },
  };
}

/**
 * One transaction-capable executor over the RDS Data API. Statements keep the provider contracts'
 * named parameters; the response is read through the Data API's JSON record format so a row stays
 * a scalar record and the components parse their own aggregates.
 */
export function createDataApiTransactor(options: {
  readonly client: DataApiClient;
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
}): DeploymentSqlTransactor {
  const client = options?.client;
  if (typeof client?.send !== 'function') {
    throw new TypeError('createDataApiTransactor requires a Data API client.');
  }
  const target = {
    resourceArn: options.resourceArn,
    secretArn: options.secretArn,
    database: options.database,
  };
  const statements = createExecutor(client, target, null);
  return {
    query: statements.query,
    async transaction<T>(work: (statements: DeploymentSqlExecutor) => Promise<T>): Promise<T> {
      const begun = await client.send({
        name: 'BeginTransaction',
        input: { ...target },
      });
      const transactionId = begun.transactionId;
      if (typeof transactionId !== 'string' || transactionId.length === 0) {
        throw new Error('The RDS Data API did not open the requested transaction.');
      }
      try {
        const result = await work(createExecutor(client, target, transactionId));
        await client.send({
          name: 'CommitTransaction',
          input: { ...target, transactionId },
        });
        return result;
      } catch (cause) {
        try {
          await client.send({
            name: 'RollbackTransaction',
            input: { ...target, transactionId },
          });
        } catch {
          // The operation's own failure is what the caller acts on; a failed rollback must not
          // replace it, and the transaction is abandoned server-side either way.
        }
        throw cause;
      }
    },
  };
}

function createExecutor(
  client: DataApiClient,
  target: {
    readonly resourceArn: string;
    readonly secretArn: string;
    readonly database: string;
  },
  transactionId: string | null,
): DeploymentSqlExecutor {
  return {
    async query(statement, parameters = {}) {
      const response = await client.send({
        name: 'ExecuteStatement',
        input: {
          ...target,
          sql: statement,
          parameters: dataApiParameters(parameters),
          formatRecordsAs: 'JSON',
          includeResultMetadata: false,
          ...(transactionId === null ? {} : { transactionId }),
        },
      });
      return readFormattedRecords(response.formattedRecords);
    },
  };
}

/** Maps named parameters to the Data API's typed parameter list; values stay scalar. */
function dataApiParameters(
  parameters: Readonly<Record<string, DeploymentSqlValue>>,
): readonly { readonly name: string; readonly value: Readonly<Record<string, unknown>> }[] {
  return Object.entries(parameters).map(([name, value]) => ({
    name,
    value:
      value === null
        ? { isNull: true }
        : typeof value === 'string'
          ? { stringValue: value }
          : typeof value === 'boolean'
            ? { booleanValue: value }
            : Number.isInteger(value)
              ? { longValue: value }
              : { doubleValue: value },
  }));
}

function readFormattedRecords(value: unknown): readonly DeploymentSqlRow[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value !== 'string') {
    throw new Error('The RDS Data API returned a result that is not readable.');
  }
  if (value.trim() === '') {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    throw new Error('The RDS Data API returned a result that is not readable.', { cause });
  }
  if (!Array.isArray(decoded)) {
    throw new Error('The RDS Data API returned a result that is not a record list.');
  }
  return decoded.map((record) => readRecord(record));
}

function readRecord(value: unknown): DeploymentSqlRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The RDS Data API returned a record that is not readable.');
  }
  const record: Record<string, DeploymentSqlValue> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      throw new Error('The RDS Data API returned a column value that is not scalar.');
    }
    record[name] = entry;
  }
  return record;
}

/** Adapts the AWS S3 client to the snapshot-object port this composition reads through. */
export function createS3SnapshotClient(client: S3Client): SnapshotObjectClient {
  if (typeof client?.send !== 'function') {
    throw new TypeError('createS3SnapshotClient requires an S3 client.');
  }
  return {
    async head(command) {
      const response = (await client.send(
        new HeadObjectCommand({ Bucket: command.input.Bucket, Key: command.input.Key }),
      )) as HeadObjectCommandOutput;
      return {
        metadata: readObjectMetadata(response.Metadata),
        version: readStringValue(response.VersionId),
      };
    },
    async get(command) {
      const response = (await client.send(
        new GetObjectCommand({
          Bucket: command.input.Bucket,
          Key: command.input.Key,
          ...(command.input.VersionId === undefined ? {} : { VersionId: command.input.VersionId }),
        }),
      )) as GetObjectCommandOutput;
      return {
        metadata: readObjectMetadata(response.Metadata),
        body: decodeBody(response.Body),
        version: readStringValue(response.VersionId),
      };
    },
    destroy() {
      destroyClient(client);
    },
  };
}

function readObjectMetadata(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const metadata: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      metadata[name] = entry;
    }
  }
  return metadata;
}

async function* decodeBody(body: unknown): AsyncGenerator<string> {
  if (typeof body !== 'object' || body === null) {
    throw new Error('The snapshot object carried no readable body.');
  }
  const stream = body as AsyncIterable<unknown>;
  if (typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('The snapshot object carried no readable body.');
  }
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? decoder.decode(chunk, { stream: true })
          : null;
    if (text === null) {
      throw new Error('The snapshot object carried a chunk that is not readable text.');
    }
    if (text.length > 0) {
      yield text;
    }
  }
  const trailing = decoder.decode();
  if (trailing.length > 0) {
    yield trailing;
  }
}

/**
 * The configured snapshot source: one object per dataset under the configured prefix, and the
 * provider version the deployment recorded in the object's metadata when it uploaded the snapshot.
 *
 * The metadata read and the body read belong to one object version: the source pins the body
 * request to the version the metadata reported, so a snapshot replaced concurrently can never
 * publish content under another version's identity. Opening the snapshot performs the metadata
 * read only; the transfer starts with the first read of {@link CatalogSnapshot.text} and is
 * released when iteration ends, fails or is cancelled before it ever starts.
 */
export function createS3SnapshotSource(options: {
  readonly client: SnapshotObjectClient;
  readonly bucket: string;
  readonly prefix: string | null;
}): CatalogSnapshotSource {
  const client = options?.client;
  if (typeof client?.head !== 'function' || typeof client.get !== 'function') {
    throw new TypeError('createS3SnapshotSource requires a snapshot object client.');
  }
  const bucket = options.bucket;
  const prefix = options.prefix ?? '';
  return {
    async open(request: CatalogSynchronizationRequest): Promise<CatalogSnapshot> {
      const key = `${prefix}${request.dataset}.jsonl`;
      const command: SnapshotObjectCommand = {
        name: 'HeadObject',
        input: { Bucket: bucket, Key: key },
      };
      const head = await client.head(command);
      const sourceVersion = head.metadata[SNAPSHOT_VERSION_METADATA_KEY];
      if (typeof sourceVersion !== 'string' || sourceVersion.length === 0) {
        throw new Error(`The ${request.dataset} snapshot does not record its provider version.`);
      }

      async function* openBody(): AsyncGenerator<string> {
        const object = await client.get({
          name: 'GetObject',
          input: {
            Bucket: bucket,
            Key: key,
            ...(head.version === null ? {} : { VersionId: head.version }),
          },
        });
        try {
          if (object.version !== head.version) {
            throw new Error(
              `The ${request.dataset} snapshot changed between its metadata and its content read.`,
            );
          }
          yield* decodeBody(object.body);
        } finally {
          releaseObjectBody(object.body);
        }
      }

      return {
        sourceName: CATALOG_SNAPSHOT_SOURCE_NAME,
        sourceVersion,
        text: openBody(),
      };
    },
  };
}

/**
 * Releases one object body whose iteration ended, failed or was cancelled before the transfer
 * finished. The deployed SDK streams own a socket, so the body is destroyed; a substitute that
 * exposes no release is already finished or owned elsewhere, and an already released body makes
 * this call a no-op.
 */
function releaseObjectBody(body: unknown): void {
  if (typeof body !== 'object' || body === null) {
    return;
  }
  for (const name of ['destroy', 'cancel', 'return'] as const) {
    const release: unknown = Reflect.get(body, name);
    if (typeof release !== 'function') {
      continue;
    }
    try {
      release.call(body);
    } catch {
      // Releasing is best effort: the consumer's own outcome is what the run reports.
    }
    return;
  }
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

/** Composes the interactive runtime: the reader credential and the UserCards writer credential. */
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
      readSql: createDataApiTransactor({
        client,
        resourceArn: resources.catalogDatabase.resourceArn,
        secretArn: resources.catalogDatabase.secretArn,
        database: resources.catalogDatabase.database,
      }),
      writeSql: createDataApiTransactor({
        client,
        resourceArn: resources.userCardsDatabase.resourceArn,
        secretArn: resources.userCardsDatabase.secretArn,
        database: resources.userCardsDatabase.database,
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

/** One HTTP API (payload format 2.0) event as the deployed entry point receives it. */
export interface ApiGatewayHttpApiEvent {
  readonly rawPath?: unknown;
  readonly rawQueryString?: unknown;
  readonly queryStringParameters?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly isBase64Encoded?: unknown;
  readonly requestContext?: unknown;
}

export interface LambdaHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The interactive entry point: one HTTP API invocation becomes one transport request that carries
 * the claims the API's JWT authorizer verified, the request identity and the decoded body. The
 * request boundary re-checks the claims against this environment's pool and app client before any
 * private operation runs, so a development or test token authorizes nothing here.
 */
export function createApiGatewayHandler(
  target: Pick<Application, 'handle'>,
): (event: unknown) => Promise<LambdaHttpResponse> {
  if (typeof target?.handle !== 'function') {
    throw new TypeError('createApiGatewayHandler requires the application request boundary.');
  }
  return async function handler(event: unknown): Promise<LambdaHttpResponse> {
    const response = await dispatch(target, event);
    return { statusCode: response.status, headers: response.headers, body: response.body };
  };
}

async function dispatch(
  target: Pick<Application, 'handle'>,
  event: unknown,
): Promise<TransportResponse> {
  let request: TransportRequest;
  try {
    request = readTransportRequest(event);
  } catch (cause) {
    return failureResponse(
      new ApplicationError('invalid-request', 'The invocation is not a readable HTTP request.', {
        cause,
      }),
    );
  }
  try {
    return await target.handle(request);
  } catch (cause) {
    // The request boundary reports its own failures; a failure it cannot classify is an
    // unavailable operation, and never leaks storage, credentials or provider exceptions.
    return failureResponse(
      cause instanceof ApplicationError
        ? cause
        : new ApplicationError('unavailable', 'The operation could not be completed.', { cause }),
    );
  }
}

function readTransportRequest(event: unknown): TransportRequest {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError('The invocation carries no event.');
  }
  const record = event as Readonly<Record<string, unknown>>;
  const requestContext = readRecordValue(record.requestContext);
  const http = readRecordValue(requestContext?.http);
  const method = readStringValue(http?.method);
  const path = readStringValue(record.rawPath) ?? readStringValue(http?.path);
  if (method === null || path === null) {
    throw new TypeError('The invocation carries no method or path.');
  }
  const claims = readRecordValue(readRecordValue(requestContext?.authorizer)?.jwt)?.claims;
  const body = readBody(record);
  return {
    method,
    path,
    query: readQuery(record.queryStringParameters),
    authentication: { claims: normalizeAuthorizerClaims(claims) },
    body,
    requestId: readStringValue(requestContext?.requestId),
  };
}

/**
 * Claims of an HTTP API JWT authorizer: the verified token's claims, with every value delivered as
 * text (AWS's `APIGatewayV2HTTPRequestContextAuthorizerJWTDescription`). Application's verifier
 * reads the registered expiry as a number of seconds, so this boundary normalizes that one claim
 * back to its JSON type and passes everything else on unchanged. A claim that does not carry a
 * whole number of seconds stays as it arrived, and the verifier rejects the invocation.
 */
function normalizeAuthorizerClaims(value: unknown): Readonly<Record<string, unknown>> | null {
  const claims = readRecordValue(value);
  if (claims === null) {
    return null;
  }
  const expiry = claims.exp;
  if (typeof expiry !== 'string' || !/^\d+$/.test(expiry)) {
    return claims;
  }
  return { ...claims, exp: Number(expiry) };
}

function readBody(event: Readonly<Record<string, unknown>>): string | null {
  const body = event.body;
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body !== 'string') {
    throw new TypeError('The invocation carries a body that is not text.');
  }
  if (event.isBase64Encoded === true) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}

function readQuery(value: unknown): Readonly<Record<string, string>> | null {
  const query = readRecordValue(value);
  if (query === null) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(query)) {
    if (typeof entry === 'string') {
      values[name] = entry;
    }
  }
  return values;
}

function readRecordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface CatalogJobOptions {
  /** Environment of the finite job, for example `process.env`. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Dataset to ingest; the deployed job ingests the configured provider's default list. */
  readonly dataset?: string;
  readonly dataApi?: DataApiClient;
  readonly snapshots?: SnapshotObjectClient;
  /** Sink for the job's outcome record; the container writes it to its log group. */
  readonly log?: (record: Readonly<Record<string, unknown>>) => void;
}

export interface CatalogJobOutcome {
  readonly ok: boolean;
  readonly failureCode: ApplicationFailureCode | null;
  readonly revision: CatalogRevision | null;
}

/**
 * The finite catalog job: one invocation ingests one provider snapshot into a candidate revision
 * and publishes it atomically, or reports why it published nothing. The job holds only the Catalog
 * writer credential, releases its clients when the run ends and reports its outcome as a record
 * the run's log group keeps.
 */
export async function runCatalogJob(options: CatalogJobOptions): Promise<CatalogJobOutcome> {
  const log = options.log ?? ((record) => console.info(JSON.stringify(record)));
  const startedAt = Date.now();
  let configuration: CatalogJobConfiguration;
  try {
    configuration = readCatalogJobEnvironment(options?.environment);
  } catch (cause) {
    // A configuration the runtime cannot use is reported like any other failed run; the record
    // names the problem without carrying a variable value or credential.
    log({
      operation: 'catalog.synchronize',
      outcome: 'failed',
      failureCode: 'unavailable',
      problem: readConfigurationProblem(cause),
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, failureCode: 'unavailable', revision: null };
  }
  const ownedDataApi = options.dataApi === undefined;
  const ownedSnapshots = options.snapshots === undefined;
  const dataApi =
    options.dataApi ?? createRdsDataApiClient(new RDSDataClient({ region: configuration.region }));
  const snapshots =
    options.snapshots ?? createS3SnapshotClient(new S3Client({ region: configuration.region }));
  try {
    const synchronizer = createCatalogSynchronizer({
      sql: createDataApiTransactor({
        client: dataApi,
        resourceArn: configuration.database.clusterArn,
        secretArn: configuration.database.secretArn,
        database: configuration.database.database,
      }),
      snapshots: createS3SnapshotSource({
        client: snapshots,
        bucket: configuration.snapshots.bucket,
        prefix: configuration.snapshots.prefix,
      }),
    });
    const revision = await synchronizer.synchronize({
      dataset: options.dataset ?? CATALOG_JOB_DATASET,
    });
    log({
      operation: 'catalog.synchronize',
      environment: configuration.environment,
      outcome: 'ok',
      revisionId: revision.revisionId,
      sourceName: revision.sourceName,
      sourceVersion: revision.sourceVersion,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true, failureCode: null, revision };
  } catch (cause) {
    const failure = translateJobFailure(cause);
    log({
      operation: 'catalog.synchronize',
      environment: configuration.environment,
      outcome: 'failed',
      failureCode: failure.code,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, failureCode: failure.code, revision: null };
  } finally {
    if (ownedDataApi) {
      destroyClient(dataApi);
    }
    if (ownedSnapshots) {
      destroyClient(snapshots);
    }
  }
}

function translateJobFailure(cause: unknown): ApplicationError {
  const failureCode = readFailureCode(cause);
  return new ApplicationError(
    failureCode,
    'The catalog synchronization did not publish a revision.',
    { cause },
  );
}

/** The configuration problem one failed run reports; it names variables, never their values. */
function readConfigurationProblem(cause: unknown): string {
  return cause instanceof ConfigurationError
    ? cause.message
    : 'The catalog job configuration is invalid.';
}

/** The component failure code of one cause, when the cause carries the provider vocabulary. */
function readFailureCode(cause: unknown): ApplicationFailureCode {
  const code = readRecordValue(cause)?.code;
  return isApplicationFailureCode(code) ? code : 'unavailable';
}

function destroyClient(client: object): void {
  const destroy = Reflect.get(client, 'destroy');
  if (typeof destroy === 'function') {
    destroy.call(client);
  }
}
