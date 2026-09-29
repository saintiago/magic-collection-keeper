/**
 * Application deployment entry point
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The packaged backend runtimes are composed here: the interactive entry point reads one
 * environment's variables, validates the configuration, binds the reader and UserCards writer
 * credentials to Aurora through the RDS Data API and turns HTTP API invocations into transport
 * requests; the finite catalog job binds only the Catalog writer credential and the private
 * snapshot bucket, ingests one provider snapshot and reports the revision it published; the
 * background indexing job binds only the Search indexing credential — Search's own projection and
 * the Catalog and UserCards publications — and reports the pass it left behind. Every runtime
 * keeps the verification, scoping and diagnostic boundaries its components own, and none names a
 * resource coordinate the deployment did not configure.
 *
 * This module belongs to the backend runtimes: it reaches the AWS SDK and the Node.js filesystem
 * and must never be reachable from the browser bundle. The browser composes
 * ./index.ts instead and receives public settings only.
 */

export {
  CATALOG_JOB_DATASET,
  CATALOG_SNAPSHOT_SOURCE_NAME,
  SNAPSHOT_VERSION_METADATA_KEY,
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createDataApiTransactor,
  createInteractiveDeployment,
  createRdsDataApiClient,
  createS3SnapshotClient,
  createS3SnapshotSource,
  readCatalogJobEnvironment,
  readInteractiveEnvironment,
  readIndexingJobEnvironment,
  runCatalogJob,
  runIndexingJob,
  type ApiGatewayHttpApiEvent,
  type CatalogJobConfiguration,
  type CatalogJobOptions,
  type CatalogJobOutcome,
  type DataApiClient,
  type DataApiCommand,
  type DataApiCommandName,
  type DeploymentDatabaseSettings,
  type DeploymentSqlExecutor,
  type DeploymentSqlRow,
  type DeploymentSqlTransactor,
  type DeploymentSqlValue,
  type IndexingJobConfiguration,
  type IndexingJobOptions,
  type IndexingJobOutcome,
  type InteractiveDeployment,
  type InteractiveDeploymentOptions,
  type LambdaHttpResponse,
  type SnapshotObject,
  type SnapshotObjectClient,
  type SnapshotObjectCommand,
  type SnapshotObjectCommandName,
  type SnapshotObjectHandle,
} from './internal/deployment.js';
