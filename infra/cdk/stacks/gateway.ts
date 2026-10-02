import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import {
  clone,
  environmentParameter,
  exportOutput,
  readLegacyTemplate,
  stringParameter,
  TemplateFragment,
  type ResourceDefinition,
} from '../constructs/template.js';

const resources = [
  'UserPoolClient',
  'HttpApi',
  'JwtAuthorizer',
  'DefaultStage',
  'ApiAccessLogGroup',
  'ApiServerErrorAlarm',
] as const;

export class GatewayStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper stable HTTP gateway, retained Cognito client, JWT authorizer and CORS policy.';
    const source = readLegacyTemplate('service.json');
    const fragment = new TemplateFragment(this, 'Gateway');
    fragment.addParameters(
      {
        Environment: environmentParameter(configuration.environment),
        ExistingUserPoolId: requiredParameter(source, 'ExistingUserPoolId'),
        BrowserOrigin: stringParameter(
          'HTTPS origin of the WebStack distribution.',
          '^https://.+$',
        ),
      },
      ['Environment', 'ExistingUserPoolId', 'BrowserOrigin'],
    );
    const definitions = clone(source.Resources) as Record<string, ResourceDefinition>;
    const api = definitions.HttpApi;
    if (api === undefined) throw new Error('The service template has no HttpApi.');
    definitions.HttpApi = {
      ...api,
      Properties: {
        ...api.Properties,
        Description: 'Stable gateway for independently deployed Keeper components.',
        CorsConfiguration: {
          AllowOrigins: [{ Ref: 'BrowserOrigin' }],
          AllowHeaders: ['authorization', 'content-type'],
          AllowMethods: ['GET', 'POST', 'OPTIONS'],
          MaxAge: 600,
        },
      },
    };
    fragment.addResources(definitions, resources);
    fragment.addOutput(
      'ApiId',
      exportOutput({ Ref: 'HttpApi' }, 'keeper-${Environment}-api-id', 'Stable HTTP API ID.'),
    );
    fragment.addOutput(
      'AuthorizerId',
      exportOutput(
        { Ref: 'JwtAuthorizer' },
        'keeper-${Environment}-authorizer-id',
        'JWT authorizer used by browser-facing component routes.',
      ),
    );
    fragment.addOutput(
      'ApiBaseUrl',
      exportOutput(
        { 'Fn::GetAtt': ['HttpApi', 'ApiEndpoint'] },
        'keeper-${Environment}-api-base-url',
      ),
    );
    fragment.addOutput(
      'UserPoolId',
      exportOutput({ Ref: 'ExistingUserPoolId' }, 'keeper-${Environment}-user-pool-id'),
    );
    fragment.addOutput(
      'UserPoolClientId',
      exportOutput({ Ref: 'UserPoolClient' }, 'keeper-${Environment}-user-pool-client-id'),
    );
  }
}

function requiredParameter(source: ReturnType<typeof readLegacyTemplate>, name: string) {
  const parameter = source.Parameters?.[name];
  if (parameter === undefined) throw new Error(`The service template has no ${name} parameter.`);
  return parameter;
}
