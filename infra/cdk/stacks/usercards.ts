import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import {
  addLambdaService,
  lambdaArtifactParameters,
  type LambdaServiceDefinition,
} from '../constructs/lambda-service.js';
import { environmentParameter, importValue, TemplateFragment } from '../constructs/template.js';

const userCardsRoutes = [
  ['POST', '/api/collection/query'],
  ['POST', '/api/collection/fragments'],
  ['GET', '/api/collection/copies/{copyId}'],
  ['POST', '/api/collection/copies/read'],
  ['POST', '/api/collection/copies'],
  ['POST', '/api/collection/copies/{copyId}/corrections'],
  ['POST', '/api/collection/copies/{copyId}/location'],
  ['GET', '/api/collection/tags'],
  ['POST', '/api/collection/tags'],
  ['GET', '/api/collection/tags/{tagId}/associations'],
  ['POST', '/api/collection/tags/read'],
  ['POST', '/api/collection/tags/{tagId}/rename'],
  ['POST', '/api/collection/associations/read'],
  ['POST', '/api/collection/associations'],
  ['POST', '/api/collection/associations/{associationId}/changes'],
  ['POST', '/api/collection/associations/{associationId}/removal'],
  ['GET', '/api/collection/imports'],
  ['POST', '/api/collection/imports/sources'],
  ['GET', '/api/collection/imports/operations/{operationId}'],
  ['GET', '/api/collection/imports/{sessionId}/entries'],
  ['POST', '/api/collection/imports/{sessionId}/entries'],
  ['POST', '/api/collection/imports/{sessionId}/captures'],
  ['POST', '/api/collection/imports/{sessionId}/discard'],
  ['POST', '/api/collection/imports/{sessionId}/confirmation'],
  ['POST', '/api/collection/imports/entries/{entryId}/review'],
  ['POST', '/api/collection/imports/entries/{entryId}/candidates'],
  ['POST', '/api/collection/imports/entries/{entryId}/discard'],
] as const;

const definition: LambdaServiceDefinition = {
  stem: 'usercards',
  logicalStem: 'UserCards',
  description: 'UserCards private query and mutation runtime',
  codeKeyParameter: 'UserCardsCodeKey',
  codeVersionParameter: 'UserCardsCodeVersion',
  environment: {
    KEEPER_ENVIRONMENT: { Ref: 'Environment' },
    KEEPER_DATABASE_CLUSTER_ARN: importValue('keeper-${Environment}-database-cluster-arn'),
    KEEPER_DATABASE_NAME: importValue('keeper-${Environment}-database-name'),
    KEEPER_DATABASE_USERCARDS_READER_SECRET_ARN: importValue(
      'keeper-${Environment}-usercards-reader-secret-arn',
    ),
    KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN: importValue(
      'keeper-${Environment}-usercards-writer-secret-arn',
    ),
    KEEPER_USER_POOL_ID: importValue('keeper-${Environment}-user-pool-id'),
    KEEPER_USER_POOL_CLIENT_ID: importValue('keeper-${Environment}-user-pool-client-id'),
    KEEPER_CATALOG_BASE_URL: importValue('keeper-${Environment}-api-base-url'),
    KEEPER_SOURCE_IMPORTS: 'true',
    KEEPER_REQUEST_TIMEOUT_MS: '20000',
  },
  secretExports: [
    'keeper-${Environment}-usercards-reader-secret-arn',
    'keeper-${Environment}-usercards-writer-secret-arn',
  ],
  routes: userCardsRoutes.map(([method, path]) => ({ method, path })),
  extraPolicyStatements: [
    {
      Sid: 'CatalogService',
      Effect: 'Allow',
      Action: 'execute-api:Invoke',
      Resource: {
        'Fn::Sub': [
          'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/internal/api/catalog/*',
          { ApiId: importValue('keeper-${Environment}-api-id') },
        ],
      },
    },
  ],
};

export class UserCardsStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper independently deployable UserCards runtime and account-scoped gateway routes.';
    const fragment = new TemplateFragment(this, 'UserCards');
    fragment.addParameters(
      {
        Environment: environmentParameter(configuration.environment),
        ...lambdaArtifactParameters(definition, configuration.artifacts?.userCards),
      },
      ['Environment', definition.codeKeyParameter, definition.codeVersionParameter],
    );
    addLambdaService(fragment, definition, configuration);
    fragment.addOutput('UserCardsFunctionName', { Value: { Ref: 'UserCardsFunction' } });
  }
}
