import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import type { DeploymentConfiguration } from '../configuration.js';
import { withGatewayImports } from '../constructs/references.js';
import {
  environmentParameter,
  exportOutput,
  readLegacyTemplate,
  TemplateFragment,
  type ResourceDefinition,
} from '../constructs/template.js';

const recognitionResources = [
  'RecognitionLogGroup',
  'RecognitionFunction',
  'RecognitionFunctionRole',
  'RecognitionIntegration',
  'RecognitionRoute',
  'RecognitionIndependentRoute',
  'RecognitionSourceRoute',
  'RecognitionFunctionPermission',
  'RecognitionIndependentPermission',
  'RecognitionSourcePermission',
  'RecognitionFunctionErrorsAlarm',
] as const;

export class RecognitionStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    configuration: DeploymentConfiguration,
    props?: StackProps,
  ) {
    super(scope, id, props);
    this.templateOptions.description =
      'Keeper independently deployable Recognition image, Lambda, routes, permissions and alarms.';
    const foundation = readLegacyTemplate('foundation.json');
    const service = readLegacyTemplate('service.json');
    const fragment = new TemplateFragment(this, 'Recognition');
    if (configuration.stage === 'image-repositories') {
      fragment.addParameters({ Environment: environmentParameter(configuration.environment) }, [
        'Environment',
      ]);
      fragment.addResource(
        'RecognitionRepository',
        requiredResource(foundation, 'RecognitionRepository'),
      );
      fragment.addOutput(
        'RecognitionRepositoryUri',
        exportOutput(
          { 'Fn::GetAtt': ['RecognitionRepository', 'RepositoryUri'] },
          'keeper-${Environment}-recognition-repository-uri',
        ),
      );
      fragment.addOutput('RecognitionRepositoryName', {
        Value: { Ref: 'RecognitionRepository' },
      });
      return;
    }
    fragment.addParameters(
      {
        Environment: environmentParameter(configuration.environment),
        RecognitionImageUri: withDefault(
          requiredParameter(service, 'RecognitionImageUri'),
          configuration.artifacts?.recognitionImageUri,
        ),
        TitleModelId: requiredParameter(service, 'TitleModelId'),
        IdentityModelId: requiredParameter(service, 'IdentityModelId'),
      },
      ['Environment', 'RecognitionImageUri', 'TitleModelId', 'IdentityModelId'],
    );
    fragment.addConditions(service.Conditions ?? {}, ['TitleModel', 'IdentityModel']);
    fragment.addResource(
      'RecognitionRepository',
      requiredResource(foundation, 'RecognitionRepository'),
    );
    for (const name of recognitionResources) {
      fragment.addResource(name, withGatewayImports(requiredResource(service, name)));
    }
    fragment.addOutput(
      'RecognitionRepositoryUri',
      exportOutput(
        { 'Fn::GetAtt': ['RecognitionRepository', 'RepositoryUri'] },
        'keeper-${Environment}-recognition-repository-uri',
      ),
    );
    fragment.addOutput('RecognitionRepositoryName', {
      Value: { Ref: 'RecognitionRepository' },
    });
    fragment.addOutput('RecognitionFunctionName', { Value: { Ref: 'RecognitionFunction' } });
  }
}

function requiredParameter(source: ReturnType<typeof readLegacyTemplate>, name: string) {
  const parameter = source.Parameters?.[name];
  if (parameter === undefined) throw new Error(`The service template has no ${name} parameter.`);
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
