import type { TemplateFragment } from './template.js';
import { importValue, type ParameterDefinition } from './template.js';

const dataApiActions = [
  'rds-data:BatchExecuteStatement',
  'rds-data:BeginTransaction',
  'rds-data:CommitTransaction',
  'rds-data:ExecuteStatement',
  'rds-data:RollbackTransaction',
];

export interface LambdaServiceDefinition {
  readonly stem: 'catalog-serving' | 'usercards';
  readonly logicalStem: 'CatalogServing' | 'UserCards';
  readonly description: string;
  readonly codeKeyParameter: string;
  readonly codeVersionParameter: string;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly secretExports: readonly string[];
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
    readonly authorization?: 'AWS_IAM';
  }[];
  readonly extraPolicyStatements?: readonly Readonly<Record<string, unknown>>[];
}

export function lambdaArtifactParameters(
  definition: LambdaServiceDefinition,
  artifact?: { readonly key: string; readonly version: string } | null,
): Readonly<Record<string, ParameterDefinition>> {
  return {
    [definition.codeKeyParameter]: {
      Type: 'String',
      Description: `Immutable artifact-bucket key of the ${definition.stem} Lambda zip.`,
      MinLength: 1,
      ...(artifact == null ? {} : { Default: artifact.key }),
    },
    [definition.codeVersionParameter]: {
      Type: 'String',
      Description: `S3 object version of the ${definition.stem} Lambda zip.`,
      MinLength: 1,
      ...(artifact == null ? {} : { Default: artifact.version }),
    },
  };
}

export function addLambdaService(
  fragment: TemplateFragment,
  definition: LambdaServiceDefinition,
): void {
  const stem = definition.logicalStem;
  const logGroup = `${stem}LogGroup`;
  const role = `${stem}FunctionRole`;
  const functionName = `${stem}Function`;
  const integration = `${stem}Integration`;

  fragment.addResource(logGroup, {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: { 'Fn::Sub': `/aws/lambda/keeper-\${Environment}-${definition.stem}` },
      RetentionInDays: 30,
      Tags: tags(),
    },
  });
  fragment.addResource(role, {
    Type: 'AWS::IAM::Role',
    Properties: {
      Description: `${definition.description}; credentials remain limited to this component.`,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      Policies: [
        {
          PolicyName: `${stem}RuntimeAccess`,
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'Logs',
                Effect: 'Allow',
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: { 'Fn::Sub': `\${${logGroup}.Arn}:*` },
              },
              {
                Sid: 'DataApi',
                Effect: 'Allow',
                Action: dataApiActions,
                Resource: importValue('keeper-${Environment}-database-cluster-arn'),
              },
              {
                Sid: 'DatabaseSecrets',
                Effect: 'Allow',
                Action: 'secretsmanager:GetSecretValue',
                Resource: definition.secretExports.map((name) => importValue(name)),
              },
              ...(definition.extraPolicyStatements ?? []),
            ],
          },
        },
      ],
      Tags: tags(),
    },
  });
  fragment.addResource(functionName, {
    Type: 'AWS::Lambda::Function',
    DependsOn: logGroup,
    Properties: {
      FunctionName: { 'Fn::Sub': `keeper-\${Environment}-${definition.stem}` },
      Description: definition.description,
      Runtime: 'nodejs24.x',
      Handler: 'index.handler',
      Architectures: ['x86_64'],
      MemorySize: 1024,
      Timeout: 25,
      Role: { 'Fn::GetAtt': [role, 'Arn'] },
      Code: {
        S3Bucket: importValue('keeper-${Environment}-artifacts-bucket'),
        S3Key: { Ref: definition.codeKeyParameter },
        S3ObjectVersion: { Ref: definition.codeVersionParameter },
      },
      Environment: { Variables: definition.environment },
      Tags: tags(),
    },
  });
  fragment.addResource(integration, {
    Type: 'AWS::ApiGatewayV2::Integration',
    Properties: {
      ApiId: importValue('keeper-${Environment}-api-id'),
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: { 'Fn::GetAtt': [functionName, 'Arn'] },
      PayloadFormatVersion: '2.0',
      TimeoutInMillis: 29000,
    },
  });
  definition.routes.forEach((route, index) => {
    const routeName = `${stem}Route${index + 1}`;
    fragment.addResource(routeName, {
      Type: 'AWS::ApiGatewayV2::Route',
      Properties: {
        ApiId: importValue('keeper-${Environment}-api-id'),
        RouteKey: `${route.method} ${route.path}`,
        AuthorizationType: route.authorization ?? 'JWT',
        ...(route.authorization === 'AWS_IAM'
          ? {}
          : {
              AuthorizationScopes: [],
              AuthorizerId: importValue('keeper-${Environment}-authorizer-id'),
            }),
        Target: { 'Fn::Sub': `integrations/\${${integration}}` },
      },
    });
  });
  fragment.addResource(`${stem}FunctionPermission`, {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      FunctionName: { Ref: functionName },
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
      SourceArn: {
        'Fn::Sub': [
          'arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*',
          { ApiId: importValue('keeper-${Environment}-api-id') },
        ],
      },
    },
  });
  fragment.addResource(`${stem}FunctionErrorsAlarm`, {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: { 'Fn::Sub': `keeper-\${Environment}-${definition.stem}-errors` },
      AlarmDescription: `${definition.description} reported a failed invocation.`,
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Dimensions: [{ Name: 'FunctionName', Value: { Ref: functionName } }],
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: [importValue('keeper-${Environment}-alarm-topic-arn')],
    },
  });
}

function tags(): readonly Readonly<Record<string, unknown>>[] {
  return [
    { Key: 'Environment', Value: { Ref: 'Environment' } },
    { Key: 'Application', Value: 'magic-collection-keeper' },
  ];
}
