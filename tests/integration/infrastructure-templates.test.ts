/**
 * Integration scope: the CloudFormation definitions of the rebuild's AWS stack
 * (docs/operations.md#infrastructure, docs/tech-stack.md#aws-stack). These cases hold the two
 * committed templates to the documented boundary, so a change that widens authorization, exposes
 * the database, reuses an existing resource other than the owner's user pool or introduces
 * provisioned or periodic compute fails here.
 *
 * Template validity is established separately by the pinned linter of
 * `npm run lint:infrastructure`; neither check is deployed evidence. The configured identity and
 * network boundaries are checked against a real environment (infra/README.md).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

import {
  createS3SnapshotClient,
  createS3SnapshotSource,
} from '../../src/application/deployment.js';

import { applicationEnvironments } from '../../src/application/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Json = Readonly<Record<string, unknown>>;

interface Parameter {
  readonly Type: string;
  readonly Default?: unknown;
  readonly AllowedValues?: readonly unknown[];
  readonly AllowedPattern?: string;
}

interface Resource {
  readonly Type: string;
  readonly Properties?: Json;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface Template {
  readonly AWSTemplateFormatVersion?: string;
  readonly Description?: string;
  readonly Parameters?: Readonly<Record<string, Parameter>>;
  readonly Resources: Readonly<Record<string, Resource>>;
  readonly Outputs?: Readonly<Record<string, { readonly Export?: { readonly Name?: unknown } }>>;
}

function readTemplate(file: string): Template {
  return JSON.parse(readFileSync(path.join(root, 'infra', file), 'utf8')) as Template;
}

const foundation = readTemplate('foundation.json');
const service = readTemplate('service.json');
const templates = { 'foundation.json': foundation, 'service.json': service } as const;

function resourcesOfType(
  template: Template,
  type: string,
): readonly (readonly [string, Resource])[] {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

function singleResource(template: Template, type: string): readonly [string, Resource] {
  const found = resourcesOfType(template, type);
  expect(found, type).toHaveLength(1);
  const entry = found[0];
  if (entry === undefined) throw new Error(`The template defines no ${type}.`);
  return entry;
}

function properties(entry: readonly [string, Resource]): Json {
  return entry[1].Properties ?? {};
}

/** The logical name one `Ref` points at, or an empty string for another value shape. */
function refName(value: unknown): string {
  const ref = (value as { readonly Ref?: unknown } | null | undefined)?.Ref;
  return typeof ref === 'string' ? ref : '';
}

/** Every string stored under one property name, at any depth of the document. */
function stringsForProperty(node: unknown, property: string): readonly string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === property && typeof child === 'string') found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

/** Inline policy statements of one role, with `Fn::If` branches resolved and `AWS::NoValue` dropped. */
function policyStatements(role: Resource): readonly Json[] {
  const statements: Json[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Json;
    const branch = record['Fn::If'];
    if (Array.isArray(branch)) {
      visit(branch[1]);
      return;
    }
    if (record['Ref'] === 'AWS::NoValue') return;
    if (record.Effect !== undefined) {
      statements.push(record);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(role.Properties?.Policies ?? []);
  return statements;
}

function actionsOf(statement: Json): readonly string[] {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  return Array.isArray(action)
    ? action.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The name of one `Fn::ImportValue`, which every template expresses as a `Fn::Sub` string. */
function importedName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const substitution = (value as Json | null | undefined)?.['Fn::Sub'];
  return typeof substitution === 'string' ? substitution : null;
}

function importNames(node: unknown): readonly string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'Fn::ImportValue') {
        const name = importedName(child);
        if (name !== null) names.push(name);
      }
      visit(child);
    }
  };
  visit(node);
  return names;
}

function exportNames(template: Template): readonly string[] {
  const names: string[] = [];
  for (const output of Object.values(template.Outputs ?? {})) {
    const name = importedName(output.Export?.Name);
    if (name !== null) names.push(name);
  }
  return names;
}

/** Whether one alarm action publishes to the shared topic of its environment. */
function referencesAlarmTopic(action: unknown): boolean {
  if (refName(action) === 'AlarmTopic') return true;
  const imported = (action as { readonly 'Fn::ImportValue'?: unknown } | null | undefined)?.[
    'Fn::ImportValue'
  ];
  return importedName(imported) === 'keeper-${Environment}-alarm-topic-arn';
}

/** Routes whose target is the named integration of the template. */
function routesForIntegration(
  template: Template,
  integration: string,
): readonly (readonly [string, Resource])[] {
  return resourcesOfType(template, 'AWS::ApiGatewayV2::Route').filter(
    ([, route]) =>
      (route.Properties?.Target as Json | undefined)?.['Fn::Sub'] ===
      `integrations/\${${integration}}`,
  );
}

/** The runtime environment variables of one Lambda function. */
function lambdaEnvironment(template: Template, functionName: string): Json {
  const environment = template.Resources[functionName]?.Properties?.Environment as Json | undefined;
  return (environment?.Variables ?? {}) as Json;
}

/** The runtime environment variables of the first container of a task definition. */
function containerEnvironment(task: Resource | undefined): Json {
  const containers = (task?.Properties?.ContainerDefinitions ?? []) as readonly Json[];
  const variables: Record<string, unknown> = {};
  for (const entry of (containers[0]?.Environment ?? []) as readonly Json[]) {
    if (typeof entry.Name === 'string') variables[entry.Name] = entry.Value;
  }
  return variables;
}

/** One foundation export reference as the templates express it. */
function importValue(name: string): Json {
  return { 'Fn::ImportValue': { 'Fn::Sub': name } };
}

/** Subnets whose route table carries a route off the VPC. */
function routableSubnets(template: Template): readonly string[] {
  const routeTables = new Set(
    resourcesOfType(template, 'AWS::EC2::Route')
      .filter(([, route]) => {
        const destination = route.Properties?.DestinationCidrBlock;
        return destination === '0.0.0.0/0' || destination === '::/0';
      })
      .map(([, route]) => refName(route.Properties?.RouteTableId)),
  );
  return resourcesOfType(template, 'AWS::EC2::SubnetRouteTableAssociation')
    .filter(([, association]) => routeTables.has(refName(association.Properties?.RouteTableId)))
    .map(([, association]) => refName(association.Properties?.SubnetId));
}

describe('rebuild infrastructure templates', () => {
  it('defines both stacks for the documented environments', () => {
    for (const [name, template] of Object.entries(templates)) {
      expect(template.AWSTemplateFormatVersion, name).toBe('2010-09-09');
      expect(template.Description ?? '', name).not.toBe('');
      expect(template.Parameters?.Environment?.AllowedValues, name).toEqual([
        ...applicationEnvironments,
      ]);
    }
  });

  it('reuses only the owner user pool and creates isolated resources otherwise', () => {
    for (const [name, template] of Object.entries(templates)) {
      for (const [parameterName, parameter] of Object.entries(template.Parameters ?? {})) {
        expect(parameter.Type, `${name} ${parameterName}`).toMatch(
          /^(String|Number|CommaDelimitedList|List<.*>)$/,
        );
      }
      expect(resourcesOfType(template, 'AWS::Cognito::UserPool'), name).toEqual([]);
    }
    expect(resourcesOfType(foundation, 'AWS::EC2::VPC')).toHaveLength(1);
    expect(resourcesOfType(foundation, 'AWS::EC2::Subnet')).toHaveLength(4);
    expect(resourcesOfType(foundation, 'AWS::S3::Bucket')).toHaveLength(3);
    expect(resourcesOfType(foundation, 'AWS::ECR::Repository')).toHaveLength(3);
  });

  it('keeps the existing user pool and adds one separate app client', () => {
    const [clientName, client] = singleResource(service, 'AWS::Cognito::UserPoolClient');
    const clientProperties = properties([clientName, client]);
    expect(clientProperties.UserPoolId).toEqual({ Ref: 'ExistingUserPoolId' });
    expect(clientProperties.GenerateSecret, clientName).toBe(false);
    expect(service.Parameters?.ExistingUserPoolId?.AllowedPattern ?? '').not.toBe('');
  });

  it('verifies the environment identity on every route except the CORS preflight route', () => {
    const [, authorizer] = singleResource(service, 'AWS::ApiGatewayV2::Authorizer');
    expect(authorizer.Properties?.AuthorizerType).toBe('JWT');
    expect(authorizer.Properties?.IdentitySource).toEqual(['$request.header.Authorization']);
    expect(authorizer.Properties?.JwtConfiguration).toEqual({
      Audience: [{ Ref: 'UserPoolClient' }],
      Issuer: {
        'Fn::Sub': 'https://cognito-idp.${AWS::Region}.amazonaws.com/${ExistingUserPoolId}',
      },
    });

    const routes = resourcesOfType(service, 'AWS::ApiGatewayV2::Route');
    expect(routes.length).toBeGreaterThan(0);
    for (const [name, route] of routes) {
      if (route.Properties?.RouteKey === 'OPTIONS /{proxy+}') {
        expect(route.Properties?.AuthorizationType, name).toBe('NONE');
        continue;
      }
      expect(route.Properties?.AuthorizationType, name).toBe('JWT');
      expect(route.Properties?.AuthorizerId, name).toEqual({ Ref: 'JwtAuthorizer' });
    }
    expect(
      routesForIntegration(service, 'InteractiveIntegration').map(
        ([, route]) => route.Properties?.RouteKey,
      ),
    ).toEqual(['ANY /api/{proxy+}', 'OPTIONS /{proxy+}']);
    expect(
      routesForIntegration(service, 'RecognitionIntegration').map(
        ([, route]) => route.Properties?.RouteKey,
      ),
    ).toEqual([
      'POST /api/recognize',
      'POST /api/recognize-independent',
      'GET /api/recognition/source',
    ]);
  });

  it('routes every preserved Recognition endpoint to the container with an invocation permission', () => {
    // The retained handler (src/recognition/python/handler.py) serves exactly these endpoints.
    const preservedEndpoints = [
      'POST /api/recognize',
      'POST /api/recognize-independent',
      'GET /api/recognition/source',
    ] as const;
    const permissions = resourcesOfType(service, 'AWS::Lambda::Permission').filter(
      ([, permission]) => refName(permission.Properties?.FunctionName) === 'RecognitionFunction',
    );
    expect(permissions).toHaveLength(preservedEndpoints.length);
    for (const endpoint of preservedEndpoints) {
      const [method, routePath] = endpoint.split(' ');
      expect(
        permissions.some(([, permission]) =>
          String(importedName(permission.Properties?.SourceArn) ?? '').endsWith(
            `/*/${method}${routePath}`,
          ),
        ),
        endpoint,
      ).toBe(true);
    }
  });

  it('binds each workload to its own writer credential', () => {
    const secretsOf = (node: unknown): readonly string[] =>
      importNames(node).filter((name) => name.endsWith('-secret-arn'));
    expect(new Set(secretsOf(service.Resources.ApiFunctionRole))).toEqual(
      new Set([
        'keeper-${Environment}-database-reader-secret-arn',
        'keeper-${Environment}-usercards-writer-secret-arn',
      ]),
    );
    expect(secretsOf(service.Resources.CatalogTaskRole)).toEqual([
      'keeper-${Environment}-catalog-writer-secret-arn',
    ]);
    // The indexing role reaches the two provider publications and Search's own projection with one
    // credential: a provider's writer secret stays out of it (docs/data-architecture.md#access-and-deployment).
    expect(secretsOf(service.Resources.IndexingTaskRole)).toEqual([
      'keeper-${Environment}-search-indexing-secret-arn',
    ]);

    const api = lambdaEnvironment(service, 'ApiFunction');
    expect(api.KEEPER_DATABASE_READER_SECRET_ARN).toEqual(
      importValue('keeper-${Environment}-database-reader-secret-arn'),
    );
    expect(api.KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN).toEqual(
      importValue('keeper-${Environment}-usercards-writer-secret-arn'),
    );
    expect(api.KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN).toBeUndefined();
    const catalog = containerEnvironment(service.Resources.CatalogTaskDefinition);
    expect(catalog.KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN).toEqual(
      importValue('keeper-${Environment}-catalog-writer-secret-arn'),
    );
    expect(catalog.KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN).toBeUndefined();
    const indexing = containerEnvironment(service.Resources.IndexingTaskDefinition);
    expect(indexing.KEEPER_DATABASE_SEARCH_INDEXING_SECRET_ARN).toEqual(
      importValue('keeper-${Environment}-search-indexing-secret-arn'),
    );
    expect(indexing.KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN).toBeUndefined();
    expect(indexing.KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN).toBeUndefined();
    expect(indexing.KEEPER_DATABASE_READER_SECRET_ARN).toBeUndefined();

    const exports = exportNames(foundation);
    expect(exports).toContain('keeper-${Environment}-usercards-writer-secret-arn');
    expect(exports).toContain('keeper-${Environment}-catalog-writer-secret-arn');
    expect(exports).toContain('keeper-${Environment}-search-indexing-secret-arn');
    expect(exports).not.toContain('keeper-${Environment}-database-writer-secret-arn');
    const usernameTemplate = (logicalName: string): string => {
      const generate = foundation.Resources[logicalName]?.Properties?.GenerateSecretString as
        Json | undefined;
      const template = generate?.SecretStringTemplate as Json | undefined;
      return String(template?.['Fn::Sub'] ?? '');
    };
    expect(usernameTemplate('ReaderSecret')).toContain('ReaderRoleName');
    expect(usernameTemplate('UserCardsWriterSecret')).toContain('UserCardsWriterRoleName');
    expect(usernameTemplate('CatalogWriterSecret')).toContain('CatalogWriterRoleName');
    expect(usernameTemplate('SearchIndexingSecret')).toContain('SearchIndexingRoleName');
  });

  it('accepts only VPC ranges that hold the four defined subnets', () => {
    const cidr = foundation.Parameters?.VpcCidr;
    const expression = new RegExp(cidr?.AllowedPattern ?? '');
    const allocations = resourcesOfType(foundation, 'AWS::EC2::Subnet').map(([, subnet]) => {
      const select = (subnet.Properties?.CidrBlock as Json | undefined)?.['Fn::Select'];
      const allocation = (select as readonly unknown[] | undefined)?.[1] as Json | undefined;
      const carve = allocation?.['Fn::Cidr'] as readonly unknown[] | undefined;
      return { count: Number(carve?.[1]), subnetPrefix: 32 - Number(carve?.[2]) };
    });
    expect(allocations).toHaveLength(4);
    for (const allocation of allocations) expect(allocation).toEqual(allocations[0]);
    const { count, subnetPrefix } = allocations[0] ?? { count: 0, subnetPrefix: 0 };
    expect(count).toBeGreaterThan(0);

    const accepted: number[] = [];
    for (let prefix = 8; prefix <= 32; prefix += 1) {
      if (expression.test(`10.42.0.0/${prefix}`)) accepted.push(prefix);
    }
    for (const prefix of accepted) {
      expect(2 ** (subnetPrefix - prefix), `/${prefix} holds the subnets`).toBeGreaterThanOrEqual(
        count,
      );
    }
    expect(accepted).toEqual([16, 17, 18, 19, 20, 21, 22]);
    expect(expression.test(String(cidr?.Default ?? '')), 'the default range').toBe(true);
    expect(expression.test('10.42.0.0/23'), '/23 is rejected').toBe(false);
    expect(expression.test('10.42.0.0/24'), '/24 is rejected').toBe(false);
  });

  it('places the database in isolated subnets and reaches it only through the Data API', () => {
    const [, cluster] = singleResource(foundation, 'AWS::RDS::DBCluster');
    expect(cluster.Properties?.EnableHttpEndpoint).toBe(true);
    expect(cluster.Properties?.StorageEncrypted).toBe(true);
    expect(cluster.Properties?.DeletionProtection).toBe(true);
    expect(cluster.Properties?.ServerlessV2ScalingConfiguration).toMatchObject({
      MinCapacity: 0,
    });

    const [, instance] = singleResource(foundation, 'AWS::RDS::DBInstance');
    expect(instance.Properties?.DBInstanceClass).toBe('db.serverless');
    expect(instance.Properties?.PubliclyAccessible).toBe(false);

    const [, subnetGroup] = singleResource(foundation, 'AWS::RDS::DBSubnetGroup');
    const databaseSubnets = (subnetGroup.Properties?.SubnetIds as readonly unknown[]).map(refName);
    expect(databaseSubnets).toHaveLength(2);
    const reachableFromOutside = routableSubnets(foundation);
    expect(reachableFromOutside.length).toBeGreaterThan(0);
    for (const subnet of databaseSubnets) {
      expect(reachableFromOutside, subnet).not.toContain(subnet);
    }

    const securityGroups = (cluster.Properties?.VpcSecurityGroupIds as readonly unknown[]).map(
      refName,
    );
    expect(securityGroups).toHaveLength(1);
    const [groupId] = securityGroups;
    const databaseGroup = groupId === undefined ? undefined : foundation.Resources[groupId];
    expect(databaseGroup?.Type).toBe('AWS::EC2::SecurityGroup');
    expect(databaseGroup?.Properties?.SecurityGroupIngress ?? []).toEqual([]);
  });

  it('permits the snapshot adapter’s metadata and version-pinned reads within its object prefix', async () => {
    const role = service.Resources.CatalogTaskRole;
    expect(role).toBeDefined();
    const objects = policyStatements(role!).find(
      (statement) => statement.Sid === 'SnapshotObjects',
    );
    expect(objects?.Effect).toBe('Allow');
    expect(objects?.Resource).toEqual({
      'Fn::Sub': [
        'arn:${AWS::Partition}:s3:::${Bucket}/${Prefix}*',
        {
          Bucket: { 'Fn::ImportValue': { 'Fn::Sub': 'keeper-${Environment}-snapshot-bucket' } },
          Prefix: { 'Fn::ImportValue': { 'Fn::Sub': 'keeper-${Environment}-snapshot-prefix' } },
        },
      ],
    });
    const permitted = actionsOf(objects ?? {});
    const required: string[] = [];
    const source = createS3SnapshotSource({
      bucket: 'keeper-test-snapshots',
      prefix: 'snapshots/',
      client: createS3SnapshotClient({
        async send(command: unknown) {
          // AWS requires GetObject for unversioned HEAD, GetObjectVersion for a versioned GET.
          expect(command instanceof HeadObjectCommand || command instanceof GetObjectCommand).toBe(
            true,
          );
          const input = (command as HeadObjectCommand | GetObjectCommand).input;
          expect(input).toMatchObject({
            Bucket: 'keeper-test-snapshots',
            Key: 'snapshots/default_cards.jsonl',
          });
          const action = input.VersionId === undefined ? 's3:GetObject' : 's3:GetObjectVersion';
          required.push(action);
          expect(permitted).toContain(action);
          return {
            Metadata: { 'source-version': '2026-09-01T00:00:00.000Z' },
            VersionId: 'version-1',
            Body: (async function* () {
              yield '{}';
            })(),
          };
        },
      } as never),
    });
    const snapshot = await source.open({ dataset: 'default_cards' });
    const chunks: string[] = [];
    for await (const chunk of snapshot.text) chunks.push(chunk);
    expect(chunks).toEqual(['{}']);
    expect(required).toEqual(['s3:GetObject', 's3:GetObjectVersion']);
    expect(permitted).toEqual(required);
  });

  it('grants every workload role one bounded inline policy', () => {
    const expectedAccess: Readonly<
      Record<string, { readonly prefixes: readonly string[]; readonly actions: readonly string[] }>
    > = {
      ApiFunctionRole: {
        prefixes: ['logs:', 'rds-data:', 'secretsmanager:'],
        actions: [
          'rds-data:ExecuteStatement',
          'secretsmanager:GetSecretValue',
          'logs:PutLogEvents',
        ],
      },
      RecognitionFunctionRole: {
        prefixes: ['bedrock:', 'logs:'],
        actions: ['bedrock:InvokeModel', 'logs:PutLogEvents'],
      },
      CatalogTaskRole: {
        prefixes: ['logs:', 'rds-data:', 's3:', 'secretsmanager:'],
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          'rds-data:ExecuteStatement',
          'secretsmanager:GetSecretValue',
          'logs:PutLogEvents',
        ],
      },
      CatalogTaskExecutionRole: {
        prefixes: ['ecr:', 'logs:'],
        actions: ['ecr:BatchGetImage', 'logs:PutLogEvents'],
      },
      IndexingTaskRole: {
        prefixes: ['logs:', 'rds-data:', 'secretsmanager:'],
        actions: [
          'rds-data:ExecuteStatement',
          'secretsmanager:GetSecretValue',
          'logs:PutLogEvents',
        ],
      },
      IndexingTaskExecutionRole: {
        prefixes: ['ecr:', 'logs:'],
        actions: ['ecr:BatchGetImage', 'logs:PutLogEvents'],
      },
    };
    for (const [templateName, template] of Object.entries(templates)) {
      for (const [roleName, role] of resourcesOfType(template, 'AWS::IAM::Role')) {
        expect(role.Properties?.ManagedPolicyArns, `${templateName} ${roleName}`).toBeUndefined();
        const statements = policyStatements(role);
        expect(statements.length, `${templateName} ${roleName}`).toBeGreaterThan(0);
        for (const statement of statements) {
          const actions = actionsOf(statement);
          expect(actions.length, `${templateName} ${roleName}`).toBeGreaterThan(0);
          if (statement.Resource === '*') {
            expect(actions, `${templateName} ${roleName}`).toEqual(['ecr:GetAuthorizationToken']);
          }
        }
      }
    }

    for (const [roleName, expected] of Object.entries(expectedAccess)) {
      const role = service.Resources[roleName] ?? foundation.Resources[roleName];
      expect(role, roleName).toBeDefined();
      const actions = (role === undefined ? [] : policyStatements(role)).flatMap(actionsOf);
      expect(actions.length, roleName).toBeGreaterThan(0);
      for (const action of actions) {
        expect(
          expected.prefixes.some((prefix) => action.startsWith(prefix)),
          `${roleName} ${action}`,
        ).toBe(true);
      }
      for (const action of expected.actions) {
        expect(actions, roleName).toContain(action);
      }
    }
  });

  it('retains state, keeps every bucket private and pins the artifact references', () => {
    for (const [name, bucket] of resourcesOfType(foundation, 'AWS::S3::Bucket')) {
      expect(['Retain', 'RetainExceptOnCreate'], name).toContain(bucket.DeletionPolicy);
      expect(bucket.Properties?.PublicAccessBlockConfiguration, name).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(bucket.Properties?.VersioningConfiguration, name).toEqual({ Status: 'Enabled' });
    }
    for (const [name, repository] of resourcesOfType(foundation, 'AWS::ECR::Repository')) {
      expect(repository.DeletionPolicy, name).toBe('Retain');
      expect(repository.Properties?.ImageTagMutability, name).toBe('IMMUTABLE');
    }
    for (const [name, secret] of resourcesOfType(foundation, 'AWS::SecretsManager::Secret')) {
      expect(secret.DeletionPolicy, name).toBe('Retain');
    }
    expect(singleResource(foundation, 'AWS::RDS::DBCluster')[1].DeletionPolicy).toBe('Snapshot');

    for (const parameterName of [
      'RecognitionImageUri',
      'CatalogJobImageUri',
      'IndexingJobImageUri',
    ] as const) {
      expect(service.Parameters?.[parameterName]?.AllowedPattern ?? '', parameterName).toContain(
        '@sha256:',
      );
    }
    const apiFunction = service.Resources.ApiFunction;
    expect(apiFunction?.Type).toBe('AWS::Lambda::Function');
    const code = apiFunction?.Properties?.Code as Json;
    expect(code.S3ObjectVersion).toEqual({ Ref: 'ApiCodeVersion' });
  });

  it('starts catalog synchronization and background indexing as finite tasks without schedules or warm compute', () => {
    const forbidden = [
      'AWS::ECS::Service',
      'AWS::Events::Rule',
      'AWS::Scheduler::Schedule',
      'AWS::ApplicationAutoScaling::ScalableTarget',
      'AWS::AutoScaling::AutoScalingGroup',
      'AWS::Lambda::Alias',
    ];
    for (const [name, template] of Object.entries(templates)) {
      for (const type of forbidden) {
        expect(resourcesOfType(template, type), `${name} ${type}`).toEqual([]);
      }
    }
    expect(stringsForProperty(service, 'ProvisionedConcurrencyConfig')).toEqual([]);

    // Both jobs are explicit, finite and pinned to one image digest: a release takes effect on
    // that job's next run, and nothing keeps capacity warm between runs.
    const images = new Map<string, unknown>();
    const tasks = resourcesOfType(service, 'AWS::ECS::TaskDefinition');
    expect(tasks).toHaveLength(2);
    for (const [name, task] of tasks) {
      expect(task.Properties?.RequiresCompatibilities, name).toEqual(['FARGATE']);
      expect(task.Properties?.NetworkMode, name).toBe('awsvpc');
      const containers = task.Properties?.ContainerDefinitions as readonly Json[];
      expect(containers, name).toHaveLength(1);
      const containerName = containers[0]?.Name;
      expect(typeof containerName, name).toBe('string');
      images.set(String(containerName), containers[0]?.Image);
    }
    expect(images.get('catalog-job')).toEqual({ Ref: 'CatalogJobImageUri' });
    expect(images.get('indexing-job')).toEqual({ Ref: 'IndexingJobImageUri' });
  });

  it('delivers the browser through CloudFront and its private bucket policy', () => {
    const [, distribution] = singleResource(service, 'AWS::CloudFront::Distribution');
    const config = distribution.Properties?.DistributionConfig as Json;
    const origins = config.Origins as readonly Json[];
    expect(origins).toHaveLength(1);
    expect(origins[0]?.OriginAccessControlId).toEqual({ Ref: 'OriginAccessControl' });
    expect((config.DefaultCacheBehavior as Json).ViewerProtocolPolicy).toBe('redirect-to-https');

    const [, policy] = singleResource(service, 'AWS::S3::BucketPolicy');
    expect(policy.Properties?.Bucket).toEqual({
      'Fn::ImportValue': { 'Fn::Sub': 'keeper-${Environment}-browser-bucket' },
    });
    const statements = policyStatements({
      Type: 'AWS::IAM::Role',
      Properties: { Policies: [{ PolicyDocument: policy.Properties?.PolicyDocument }] },
    });
    expect(statements).toHaveLength(1);
    expect(actionsOf(statements[0] ?? {})).toEqual(['s3:GetObject']);
    expect(statements[0]?.Condition).toMatchObject({
      StringEquals: { 'AWS:SourceArn': { 'Fn::Sub': expect.stringContaining('/${Distribution}') } },
    });
  });

  it('routes every alarm to the shared topic and bounds every log group', () => {
    for (const [name, template] of Object.entries(templates)) {
      for (const [alarmName, alarm] of resourcesOfType(template, 'AWS::CloudWatch::Alarm')) {
        const actions = alarm.Properties?.AlarmActions as readonly unknown[];
        expect(actions.length, `${name} ${alarmName}`).toBeGreaterThan(0);
        for (const action of actions) {
          expect(referencesAlarmTopic(action), `${name} ${alarmName}`).toBe(true);
        }
      }
      for (const [groupName, group] of resourcesOfType(template, 'AWS::Logs::LogGroup')) {
        expect(typeof group.Properties?.RetentionInDays, `${name} ${groupName}`).toBe('number');
      }
    }
  });

  it('exports from the foundation every value the service stack imports', () => {
    const exported = new Set(exportNames(foundation));
    const imported = new Set(importNames(service));
    expect(imported.size).toBeGreaterThan(0);
    for (const name of imported) {
      expect(exported.has(name), name).toBe(true);
    }
  });
});
