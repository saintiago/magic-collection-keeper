/** Deployment contracts for the interactive owner-read runtime and finite Catalog synchronization job. */

export {
  createApiGatewayHandler,
  createConsoleDiagnostics,
  createDataApiTransactor,
  createInteractiveDeployment,
  createRdsDataApiClient,
  readInteractiveEnvironment,
  type ApiGatewayHttpApiEvent,
  type DataApiClient,
  type DataApiCommand,
  type DataApiCommandName,
  type DeploymentSqlExecutor,
  type DeploymentSqlRow,
  type DeploymentSqlTransactor,
  type DeploymentSqlValue,
  type InteractiveDeployment,
  type InteractiveDeploymentOptions,
  type LambdaHttpResponse,
} from './internal/deployment.js';

export {
  createAwsCatalogRequest,
  createCatalogServingDeployment,
  createUserCardsServingDeployment,
  withoutInternalCatalogPrefix,
  type ServingDeployment,
} from './internal/service-deployment.js';

export {
  CATALOG_JOB_DATASET,
  CATALOG_SNAPSHOT_SOURCE_NAME,
  SNAPSHOT_VERSION_METADATA_KEY,
  createS3SnapshotClient,
  createS3SnapshotSource,
  readCatalogJobEnvironment,
  runCatalogJob,
  type CatalogJobConfiguration,
  type CatalogJobOptions,
  type CatalogJobOutcome,
  type DeploymentDatabaseSettings,
  type SnapshotObject,
  type SnapshotObjectClient,
  type SnapshotObjectCommand,
  type SnapshotObjectCommandName,
  type SnapshotObjectHandle,
} from './internal/catalog-ingestion-deployment.js';
