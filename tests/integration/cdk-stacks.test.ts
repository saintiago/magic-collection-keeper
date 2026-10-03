/** Integration contract of the independently deployable CDK stack composition. */

import { App, BootstraplessSynthesizer } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { DeploymentConfiguration } from '../../infra/cdk/configuration.js';
import { CatalogIngestionStack } from '../../infra/cdk/stacks/catalog-ingestion.js';
import { CatalogServingStack } from '../../infra/cdk/stacks/catalog-serving.js';
import { FoundationStack } from '../../infra/cdk/stacks/foundation.js';
import { GatewayStack } from '../../infra/cdk/stacks/gateway.js';
import { LegacyFoundationStack, LegacyServiceStack } from '../../infra/cdk/stacks/legacy.js';
import { RecognitionStack } from '../../infra/cdk/stacks/recognition.js';
import { UserCardsStack } from '../../infra/cdk/stacks/usercards.js';
import { WebStack } from '../../infra/cdk/stacks/web.js';

const configuration: DeploymentConfiguration = {
  environment: 'test',
  layout: 'target',
  stage: 'complete',
  artifacts: null,
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function synthesize() {
  const app = new App({ analyticsReporting: false, treeMetadata: false });
  const props = { synthesizer: new BootstraplessSynthesizer() };
  const foundation = new FoundationStack(app, 'Foundation', configuration, props);
  const gateway = new GatewayStack(app, 'Gateway', configuration, props);
  const web = new WebStack(app, 'Web', configuration, props);
  const catalogServing = new CatalogServingStack(app, 'CatalogServing', configuration, props);
  const userCards = new UserCardsStack(app, 'UserCards', configuration, props);
  const recognition = new RecognitionStack(app, 'Recognition', configuration, props);
  const catalogIngestion = new CatalogIngestionStack(app, 'CatalogIngestion', configuration, props);
  return {
    foundation: Template.fromStack(foundation),
    gateway: Template.fromStack(gateway),
    web: Template.fromStack(web),
    catalogServing: Template.fromStack(catalogServing),
    userCards: Template.fromStack(userCards),
    recognition: Template.fromStack(recognition),
    catalogIngestion: Template.fromStack(catalogIngestion),
  };
}

const stacks = synthesize();

describe('CDK deployment units', () => {
  it('preserves the legacy templates for no-op CDK adoption before splitting', () => {
    const app = new App({ analyticsReporting: false, treeMetadata: false });
    const props = { synthesizer: new BootstraplessSynthesizer() };
    const legacy = { ...configuration, layout: 'legacy' as const };
    const foundation = new LegacyFoundationStack(app, 'LegacyFoundation', legacy, props);
    const service = new LegacyServiceStack(app, 'LegacyService', legacy, props);
    const synthesized = [
      Template.fromStack(foundation).toJSON(),
      Template.fromStack(service).toJSON(),
    ];
    for (const [index, file] of ['foundation.json', 'service.json'].entries()) {
      const source = JSON.parse(readFileSync(path.join(root, 'infra', file), 'utf8')) as Record<
        string,
        unknown
      >;
      const target = synthesized[index];
      expect(target).toBeDefined();
      expect(target).toEqual(source);
    }
  });

  it('synthesizes seven top-level stacks with their documented resource owners', () => {
    stacks.foundation.resourceCountIs('AWS::RDS::DBCluster', 1);
    stacks.foundation.resourceCountIs('AWS::S3::Bucket', 1);
    expect(stacks.foundation.toJSON().Rules).toHaveProperty('DistinctDatabaseRoles');
    stacks.gateway.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    stacks.web.resourceCountIs('AWS::CloudFront::Distribution', 1);
    stacks.web.resourceCountIs('AWS::S3::Bucket', 1);
    stacks.catalogServing.resourceCountIs('AWS::Lambda::Function', 1);
    stacks.userCards.resourceCountIs('AWS::Lambda::Function', 1);
    stacks.recognition.resourceCountIs('AWS::Lambda::Function', 1);
    stacks.recognition.resourceCountIs('AWS::ECR::Repository', 1);
    stacks.catalogIngestion.resourceCountIs('AWS::ECR::Repository', 1);
    stacks.catalogIngestion.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    stacks.catalogIngestion.resourceCountIs('AWS::S3::Bucket', 1);
    stacks.catalogIngestion.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Sid: 'CatalogImage',
                Resource: { 'Fn::GetAtt': ['CatalogRepository', 'Arn'] },
              }),
            ]),
          },
        }),
      ]),
    });
    expect(stacks.foundation.toJSON().Resources.TaskSecurityGroup.Properties.GroupDescription).toBe(
      'Finite background jobs (catalog synchronization and Search indexing): outbound HTTPS only, no inbound rule',
    );
  });

  it('bootstraps image repositories before adding their consuming runtimes', () => {
    const app = new App({ analyticsReporting: false, treeMetadata: false });
    const props = { synthesizer: new BootstraplessSynthesizer() };
    const bootstrap = { ...configuration, stage: 'image-repositories' as const };
    const recognitionStack = new RecognitionStack(app, 'RecognitionBootstrap', bootstrap, props);
    const catalogStack = new CatalogIngestionStack(app, 'CatalogBootstrap', bootstrap, props);
    const recognition = Template.fromStack(recognitionStack).toJSON();
    const catalog = Template.fromStack(catalogStack).toJSON();

    expect(Object.keys(recognition.Parameters)).toEqual(['Environment']);
    expect(Object.keys(catalog.Parameters)).toEqual(['Environment']);
    expect(Object.keys(recognition.Resources)).toEqual(['RecognitionRepository']);
    expect(Object.keys(catalog.Resources)).toEqual(['CatalogRepository']);
    expect(recognition.Resources.RecognitionRepository).toEqual(
      stacks.recognition.toJSON().Resources.RecognitionRepository,
    );
    expect(catalog.Resources.CatalogRepository).toEqual(
      stacks.catalogIngestion.toJSON().Resources.CatalogRepository,
    );
  });

  it('pins independent serving artifacts and gives each runtime only owner credentials', () => {
    const catalog = stacks.catalogServing.toJSON();
    const userCards = stacks.userCards.toJSON();
    expect(Object.keys(catalog.Parameters)).toEqual([
      'Environment',
      'CatalogServingCodeKey',
      'CatalogServingCodeVersion',
    ]);
    expect(Object.keys(userCards.Parameters)).toEqual([
      'Environment',
      'UserCardsCodeKey',
      'UserCardsCodeVersion',
    ]);
    const catalogText = JSON.stringify(catalog);
    expect(catalogText).toContain('catalog-reader-secret-arn');
    expect(catalogText).not.toContain('usercards-reader-secret-arn');
    expect(catalogText).not.toContain('usercards-writer-secret-arn');
    const userCardsText = JSON.stringify(userCards);
    expect(userCardsText).toContain('usercards-reader-secret-arn');
    expect(userCardsText).toContain('usercards-writer-secret-arn');
    expect(userCardsText).not.toContain('catalog-reader-secret-arn');
    expect(userCardsText).toContain('execute-api:Invoke');
  });

  it('keeps gateway dependencies one-way and component-owned routes independently replaceable', () => {
    const gateway = JSON.stringify(stacks.gateway.toJSON());
    expect(gateway).not.toContain('AWS::Lambda::Function');
    expect(gateway).not.toContain('Distribution');
    const catalogRoutes = Object.values(stacks.catalogServing.toJSON().Resources).filter(
      (resource) => (resource as { Type?: string }).Type === 'AWS::ApiGatewayV2::Route',
    );
    const userCardsRoutes = Object.values(stacks.userCards.toJSON().Resources).filter(
      (resource) => (resource as { Type?: string }).Type === 'AWS::ApiGatewayV2::Route',
    );
    expect(catalogRoutes.length).toBeGreaterThan(5);
    expect(userCardsRoutes.length).toBeGreaterThan(20);
    expect(JSON.stringify(catalogRoutes)).toContain('AWS_IAM');
    expect(JSON.stringify(userCardsRoutes)).not.toContain('AWS_IAM');
  });

  it('retains persistent resources when a stack update replaces or deletes them', () => {
    for (const template of [
      stacks.foundation.toJSON(),
      stacks.web.toJSON(),
      stacks.recognition.toJSON(),
      stacks.catalogIngestion.toJSON(),
    ]) {
      for (const resource of Object.values(template.Resources) as Array<Record<string, unknown>>) {
        if (
          ['AWS::RDS::DBCluster', 'AWS::S3::Bucket', 'AWS::ECR::Repository'].includes(
            String(resource.Type),
          )
        ) {
          expect(resource.DeletionPolicy).toMatch(/^(Retain|RetainExceptOnCreate|Snapshot)$/);
          expect(resource.UpdateReplacePolicy).toMatch(/^(Retain|Snapshot)$/);
        }
      }
    }
  });
});
