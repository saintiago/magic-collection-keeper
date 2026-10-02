import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import { replaceImportWithRef } from '../constructs/references.js';
import {
  environmentParameter,
  exportOutput,
  readLegacyTemplate,
  TemplateFragment,
  type ResourceDefinition,
} from '../constructs/template.js';

const ingestionResources = [
  'CatalogLogGroup',
  'EcsCluster',
  'CatalogTaskDefinition',
  'CatalogTaskRole',
  'CatalogTaskExecutionRole',
] as const;

export class CatalogIngestionStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper finite Catalog ingestion image repository, source archive, task and execution boundary.';
    const foundation = readLegacyTemplate('foundation.json');
    const service = readLegacyTemplate('service.json');
    const fragment = new TemplateFragment(this, 'CatalogIngestion');
    fragment.addParameters(
      {
        Environment: environmentParameter(configuration.environment),
        SnapshotPrefix: requiredParameter(foundation, 'SnapshotPrefix'),
        CatalogJobImageUri: withDefault(
          requiredParameter(service, 'CatalogJobImageUri'),
          configuration.artifacts?.catalogIngestionImageUri,
        ),
      },
      ['Environment', 'SnapshotPrefix', 'CatalogJobImageUri'],
    );
    fragment.addResource('SnapshotBucket', requiredResource(foundation, 'SnapshotBucket'));
    fragment.addResource('CatalogRepository', requiredResource(foundation, 'CatalogRepository'));
    for (const name of ingestionResources) {
      let resource = requiredResource(service, name);
      resource = replaceImportWithRef(
        resource,
        'keeper-${Environment}-snapshot-bucket',
        'SnapshotBucket',
      );
      resource = replaceImportWithRef(
        resource,
        'keeper-${Environment}-catalog-repository-arn',
        'CatalogRepository',
      );
      resource = replaceImportWithRef(
        resource,
        'keeper-${Environment}-snapshot-prefix',
        'SnapshotPrefix',
      );
      fragment.addResource(name, resource);
    }
    fragment.addOutput(
      'SnapshotBucketName',
      exportOutput({ Ref: 'SnapshotBucket' }, 'keeper-${Environment}-snapshot-bucket'),
    );
    fragment.addOutput(
      'SnapshotPrefix',
      exportOutput({ Ref: 'SnapshotPrefix' }, 'keeper-${Environment}-snapshot-prefix'),
    );
    fragment.addOutput(
      'CatalogRepositoryArn',
      exportOutput(
        { 'Fn::GetAtt': ['CatalogRepository', 'Arn'] },
        'keeper-${Environment}-catalog-repository-arn',
      ),
    );
    fragment.addOutput('CatalogRepositoryUri', {
      Value: { 'Fn::GetAtt': ['CatalogRepository', 'RepositoryUri'] },
    });
    fragment.addOutput('CatalogRepositoryName', { Value: { Ref: 'CatalogRepository' } });
    fragment.addOutput('EcsClusterName', { Value: { Ref: 'EcsCluster' } });
    fragment.addOutput('CatalogTaskDefinitionArn', {
      Value: { Ref: 'CatalogTaskDefinition' },
    });
  }
}

function requiredParameter(source: ReturnType<typeof readLegacyTemplate>, name: string) {
  const parameter = source.Parameters?.[name];
  if (parameter === undefined) throw new Error(`The legacy template has no ${name} parameter.`);
  return parameter;
}

function withDefault<T extends Readonly<Record<string, unknown>>>(
  parameter: T,
  value: string | undefined,
): T {
  return (value === undefined ? parameter : { ...parameter, Default: value }) as T;
}

function requiredResource(
  source: ReturnType<typeof readLegacyTemplate>,
  name: string,
): ResourceDefinition {
  const resource = source.Resources[name];
  if (resource === undefined) throw new Error(`The legacy template has no ${name}.`);
  return resource;
}
