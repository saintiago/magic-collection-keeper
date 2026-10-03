import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import {
  addLambdaService,
  lambdaArtifactParameters,
  type LambdaServiceDefinition,
} from '../constructs/lambda-service.js';
import { environmentParameter, importValue, TemplateFragment } from '../constructs/template.js';

const definition: LambdaServiceDefinition = {
  stem: 'catalog-serving',
  logicalStem: 'CatalogServing',
  description: 'Catalog query and reference-resolution runtime',
  codeKeyParameter: 'CatalogServingCodeKey',
  codeVersionParameter: 'CatalogServingCodeVersion',
  environment: {
    KEEPER_ENVIRONMENT: { Ref: 'Environment' },
    KEEPER_DATABASE_CLUSTER_ARN: importValue('keeper-${Environment}-database-cluster-arn'),
    KEEPER_DATABASE_NAME: importValue('keeper-${Environment}-database-name'),
    KEEPER_DATABASE_CATALOG_READER_SECRET_ARN: importValue(
      'keeper-${Environment}-catalog-reader-secret-arn',
    ),
    KEEPER_USER_POOL_ID: importValue('keeper-${Environment}-user-pool-id'),
    KEEPER_USER_POOL_CLIENT_ID: importValue('keeper-${Environment}-user-pool-client-id'),
    KEEPER_REQUEST_TIMEOUT_MS: '20000',
  },
  secretExports: ['keeper-${Environment}-catalog-reader-secret-arn'],
  routes: [
    { method: 'POST', path: '/api/catalog/resolve' },
    { method: 'POST', path: '/api/catalog/query' },
    { method: 'GET', path: '/api/catalog/cards/{cardId}/printings' },
    { method: 'GET', path: '/api/card' },
    { method: 'GET', path: '/api/search' },
    { method: 'POST', path: '/internal/api/catalog/resolve', authorization: 'AWS_IAM' },
    { method: 'POST', path: '/internal/api/catalog/query', authorization: 'AWS_IAM' },
    {
      method: 'GET',
      path: '/internal/api/catalog/cards/{cardId}/printings',
      authorization: 'AWS_IAM',
    },
  ],
};

export class CatalogServingStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper independently deployable Catalog serving runtime and stable gateway routes.';
    const fragment = new TemplateFragment(this, 'CatalogServing');
    fragment.addParameters(
      {
        Environment: environmentParameter(configuration.environment),
        ...lambdaArtifactParameters(definition, configuration.artifacts?.catalogServing),
      },
      ['Environment', definition.codeKeyParameter, definition.codeVersionParameter],
    );
    addLambdaService(fragment, definition, configuration);
    fragment.addOutput('CatalogServingFunctionName', {
      Value: { Ref: 'CatalogServingFunction' },
    });
  }
}
