import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import {
  clone,
  environmentParameter,
  exportOutput,
  readLegacyTemplate,
  TemplateFragment,
  type ResourceDefinition,
} from '../constructs/template.js';

export class WebStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper private browser bucket and CloudFront delivery for an independently published web release.';
    const foundation = readLegacyTemplate('foundation.json');
    const service = readLegacyTemplate('service.json');
    const fragment = new TemplateFragment(this, 'Web');
    fragment.addParameters({ Environment: environmentParameter(configuration.environment) }, [
      'Environment',
    ]);
    fragment.addResource('BrowserBucket', requiredResource(foundation, 'BrowserBucket'));
    const web = clone({
      OriginAccessControl: requiredResource(service, 'OriginAccessControl'),
      Distribution: requiredResource(service, 'Distribution'),
      BrowserBucketPolicy: requiredResource(service, 'BrowserBucketPolicy'),
    });
    for (const [name, resource] of Object.entries(web)) {
      fragment.addResource(name, replaceBrowserBucketImport(resource));
    }
    fragment.addOutput(
      'BrowserBucketName',
      exportOutput({ Ref: 'BrowserBucket' }, 'keeper-${Environment}-browser-bucket'),
    );
    fragment.addOutput('BrowserUrl', {
      Value: { 'Fn::Sub': 'https://${Distribution.DomainName}' },
      Description: 'Browser application entry point.',
    });
    fragment.addOutput('DistributionId', { Value: { Ref: 'Distribution' } });
  }
}

function replaceBrowserBucketImport(resource: ResourceDefinition): ResourceDefinition {
  return replace(resource, (value) =>
    JSON.stringify(value) ===
    JSON.stringify({ 'Fn::ImportValue': { 'Fn::Sub': 'keeper-${Environment}-browser-bucket' } })
      ? { Ref: 'BrowserBucket' }
      : value,
  ) as ResourceDefinition;
}

function replace(value: unknown, transform: (value: unknown) => unknown): unknown {
  const transformed = transform(value);
  if (transformed !== value) return transformed;
  if (Array.isArray(value)) return value.map((entry) => replace(entry, transform));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, replace(entry, transform)]),
  );
}

function requiredResource(
  source: ReturnType<typeof readLegacyTemplate>,
  name: string,
): ResourceDefinition {
  const resource = source.Resources[name];
  if (resource === undefined) throw new Error(`The legacy template has no ${name}.`);
  return resource;
}
