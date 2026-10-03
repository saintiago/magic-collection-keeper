#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { assertFreshRevision, readDeploymentRecord } from './deployment-record.js';

const execFileAsync = promisify(execFile);

interface StackDescription {
  readonly Stacks?: readonly {
    readonly StackStatus?: string;
    readonly Parameters?: readonly { readonly ParameterKey?: string }[];
  }[];
}

interface Template {
  readonly Parameters?: Readonly<Record<string, { readonly Default?: unknown }>>;
  readonly Resources?: Readonly<
    Record<
      string,
      {
        readonly Type?: string;
        readonly DeletionPolicy?: string;
        readonly UpdateReplacePolicy?: string;
      }
    >
  >;
}

interface ChangeSetDescription {
  readonly Status?: string;
  readonly StatusReason?: string;
  readonly ExecutionStatus?: string;
  readonly Changes?: readonly {
    readonly ResourceChange?: {
      readonly Action?: string;
      readonly LogicalResourceId?: string;
      readonly ResourceType?: string;
      readonly Replacement?: string;
    };
  }[];
}

interface CommandLine {
  readonly stack: string;
  readonly template: string;
  readonly parameters: string;
  readonly region: string;
  readonly currentRecord: string;
  readonly revision: string;
}

/** Creates, prints and then executes one intended stack change set. */
export async function deployStack(command: CommandLine): Promise<'deployed' | 'no-op'> {
  await rejectStaleRevision(command.currentRecord, command.revision);
  const stack = await awsJson<StackDescription>([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    command.stack,
    '--region',
    command.region,
  ]);
  const described = stack.Stacks?.[0];
  if (described === undefined) throw new Error(`CloudFormation did not describe ${command.stack}.`);
  if (described.StackStatus?.endsWith('_IN_PROGRESS') === true) {
    throw new Error(`${command.stack} already has an update in progress.`);
  }
  const supplied = readParameters(
    JSON.parse(await readFile(command.parameters, 'utf8')) as unknown,
  );
  const template = readTemplate(JSON.parse(await readFile(command.template, 'utf8')) as unknown);
  const previousParameters = new Set(
    (described.Parameters ?? []).flatMap(({ ParameterKey }) =>
      ParameterKey === undefined ? [] : [ParameterKey],
    ),
  );
  const parameterArguments = buildParameterArguments(template, supplied, previousParameters);
  const changeSet = `ci-${randomUUID()}`;
  await aws([
    'cloudformation',
    'create-change-set',
    '--stack-name',
    command.stack,
    '--change-set-name',
    changeSet,
    '--change-set-type',
    'UPDATE',
    '--description',
    `Inspected GitHub Actions update for ${process.env['GITHUB_SHA'] ?? 'unknown revision'}`,
    '--template-body',
    `file://${command.template}`,
    '--capabilities',
    'CAPABILITY_NAMED_IAM',
    ...(parameterArguments.length === 0 ? [] : ['--parameters', ...parameterArguments]),
    '--region',
    command.region,
  ]);

  let description: ChangeSetDescription;
  for (;;) {
    description = await awsJson<ChangeSetDescription>([
      'cloudformation',
      'describe-change-set',
      '--stack-name',
      command.stack,
      '--change-set-name',
      changeSet,
      '--region',
      command.region,
    ]);
    if (description.Status === 'CREATE_COMPLETE') break;
    if (description.Status === 'FAILED') {
      const reason = description.StatusReason ?? '';
      if (/didn't contain changes|No updates are to be performed/i.test(reason)) {
        console.log(`${command.stack}: inspected change set is a no-op.`);
        return 'no-op';
      }
      throw new Error(`${command.stack} change-set preparation failed: ${reason}`);
    }
    await delay(2_000);
  }
  const changes = description.Changes ?? [];
  for (const change of changes) {
    const resource = change.ResourceChange;
    console.log(
      `${resource?.Action ?? 'Unknown'} ${resource?.LogicalResourceId ?? 'unknown'} ` +
        `(replacement: ${resource?.Replacement ?? 'n/a'})`,
    );
  }
  if (changes.length === 0)
    throw new Error('CloudFormation returned an empty executable change set.');
  const protectedReplacement = changes.find(({ ResourceChange: resource }) => {
    return resource !== undefined && isDestructiveProtectedChange(resource, template);
  });
  if (protectedReplacement !== undefined) {
    throw new Error(
      `Refusing destructive change to retained resource ${protectedReplacement.ResourceChange?.LogicalResourceId ?? 'unknown'}.`,
    );
  }
  await aws([
    'cloudformation',
    'execute-change-set',
    '--stack-name',
    command.stack,
    '--change-set-name',
    changeSet,
    '--region',
    command.region,
  ]);
  await aws([
    'cloudformation',
    'wait',
    'stack-update-complete',
    '--stack-name',
    command.stack,
    '--region',
    command.region,
  ]);
  return 'deployed';
}

export function buildParameterArguments(
  template: Template,
  supplied: Readonly<Record<string, string>>,
  previous: ReadonlySet<string>,
): readonly string[] {
  const desired = template.Parameters ?? {};
  const unknown = Object.keys(supplied).filter((name) => desired[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(`Parameters are not present in the desired template: ${unknown.join(', ')}.`);
  }
  return Object.entries(desired).flatMap(([name, definition]) => {
    const value = supplied[name];
    if (value !== undefined) return [`ParameterKey=${name},ParameterValue=${value}`];
    if (previous.has(name)) return [`ParameterKey=${name},UsePreviousValue=true`];
    if (definition.Default !== undefined) return [];
    throw new Error(`Required parameter ${name} has no supplied or previous value.`);
  });
}

function readTemplate(value: unknown): Template {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desired CloudFormation template must be an object.');
  }
  return value as Template;
}

function readParameters(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The parameter file must be an object of non-secret CloudFormation values.');
  }
  const parameters: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') throw new Error(`Parameter ${key} must be a string.`);
    parameters[key] = candidate;
  }
  return parameters;
}

async function aws(arguments_: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('aws', arguments_, {
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr.length > 0) process.stderr.write(stderr);
  return stdout;
}

async function awsJson<T>(arguments_: readonly string[]): Promise<T> {
  return JSON.parse(await aws([...arguments_, '--output', 'json'])) as T;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readCommandLine(argv: readonly string[]): CommandLine {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined)
      throw new Error('Missing deployment flag value.');
    values.set(flag, value);
  }
  return {
    stack: required(values, '--stack'),
    template: required(values, '--template'),
    parameters: required(values, '--parameters'),
    region: values.get('--region') ?? 'us-east-1',
    currentRecord: required(values, '--current-record'),
    revision: required(values, '--revision'),
  };
}

async function rejectStaleRevision(recordFile: string, revision: string): Promise<void> {
  const record = readDeploymentRecord(JSON.parse(await readFile(recordFile, 'utf8')) as unknown);
  await assertFreshRevision(record, revision, async (deployed, candidate) => {
    try {
      await execFileAsync('git', ['merge-base', '--is-ancestor', deployed, candidate]);
      return true;
    } catch {
      return false;
    }
  });
}

const protectedResourceTypes = new Set([
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::ECR::Repository',
  'AWS::RDS::DBCluster',
  'AWS::S3::Bucket',
  'AWS::SecretsManager::Secret',
]);

export function isDestructiveProtectedChange(
  resource: NonNullable<NonNullable<ChangeSetDescription['Changes']>[number]['ResourceChange']>,
  template: Template,
): boolean {
  if (
    resource.Action !== 'Remove' &&
    (resource.Action !== 'Modify' || resource.Replacement === 'False')
  )
    return false;
  const logicalId = resource.LogicalResourceId ?? '';
  const resourceType = resource.ResourceType;
  if (resourceType !== undefined && protectedResourceTypes.has(resourceType)) return true;
  const definition = template.Resources?.[logicalId];
  return (
    definition !== undefined &&
    (protectedResourceTypes.has(definition.Type ?? '') ||
      definition.DeletionPolicy === 'Retain' ||
      definition.DeletionPolicy === 'RetainExceptOnCreate' ||
      definition.DeletionPolicy === 'Snapshot' ||
      definition.UpdateReplacePolicy === 'Retain' ||
      definition.UpdateReplacePolicy === 'Snapshot')
  );
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new Error(`${flag} is required.`);
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outcome = await deployStack(readCommandLine(process.argv.slice(2)));
  console.log(outcome);
}
