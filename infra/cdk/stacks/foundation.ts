import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import {
  environmentParameter,
  readLegacyTemplate,
  TemplateFragment,
} from '../constructs/template.js';

const movedResources = new Set([
  'BrowserBucket',
  'SnapshotBucket',
  'CatalogRepository',
  'RecognitionRepository',
]);
const movedOutputs = new Set([
  'SnapshotBucketName',
  'SnapshotPrefix',
  'BrowserBucketName',
  'CatalogRepositoryArn',
  'CatalogRepositoryUri',
  'CatalogRepositoryName',
  'RecognitionRepositoryUri',
  'RecognitionRepositoryName',
]);

export class FoundationStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper shared foundation: networking, Aurora, owner credentials, artifacts and alarms.';
    const source = readLegacyTemplate('foundation.json');
    const fragment = new TemplateFragment(this, 'Foundation');
    fragment.addParameters(
      { ...source.Parameters, Environment: environmentParameter(configuration.environment) },
      Object.keys(source.Parameters ?? {}).filter((name) => name !== 'SnapshotPrefix'),
    );
    fragment.addResources(
      source.Resources,
      Object.keys(source.Resources).filter((name) => !movedResources.has(name)),
    );
    fragment.addOutputs(
      source.Outputs ?? {},
      Object.keys(source.Outputs ?? {}).filter((name) => !movedOutputs.has(name)),
    );
  }
}
