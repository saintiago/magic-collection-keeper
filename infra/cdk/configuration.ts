import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { App } from 'aws-cdk-lib';

import {
  readEnvironmentDeploymentBinding,
  type DeploymentUnit,
  type EnvironmentDeploymentBinding,
} from '../deployment-bindings.js';
import {
  applicationEnvironments,
  type ApplicationEnvironment,
} from '../../src/application/index.js';

export const deploymentLayouts = ['legacy', 'target'] as const;
export type DeploymentLayout = (typeof deploymentLayouts)[number];
export const deploymentStages = ['complete', 'image-repositories'] as const;
export type DeploymentStage = (typeof deploymentStages)[number];

export interface DeploymentConfiguration {
  readonly environment: ApplicationEnvironment;
  readonly layout: DeploymentLayout;
  readonly stage: DeploymentStage;
  readonly artifacts: DeploymentArtifacts | null;
  readonly bindings: EnvironmentDeploymentBinding;
}

export interface DeploymentArtifacts {
  readonly catalogServing: { readonly key: string; readonly version: string };
  readonly userCards: { readonly key: string; readonly version: string };
  readonly recognitionImageUri: string;
  readonly catalogIngestionImageUri: string;
}

/** Reads only deployment identity; artifact and resource values remain explicit stack parameters. */
export function readDeploymentConfiguration(app: App): DeploymentConfiguration {
  const environment = app.node.tryGetContext('environment');
  if (!applicationEnvironments.includes(environment as ApplicationEnvironment)) {
    throw new Error(
      `CDK context "environment" must be one of ${applicationEnvironments.join(', ')}.`,
    );
  }
  const layout = app.node.tryGetContext('layout') ?? 'target';
  if (!deploymentLayouts.includes(layout as DeploymentLayout)) {
    throw new Error(`CDK context "layout" must be one of ${deploymentLayouts.join(', ')}.`);
  }
  const stage = app.node.tryGetContext('stage') ?? 'complete';
  if (!deploymentStages.includes(stage as DeploymentStage)) {
    throw new Error(`CDK context "stage" must be one of ${deploymentStages.join(', ')}.`);
  }
  if (layout === 'legacy' && stage !== 'complete') {
    throw new Error('The image-repositories stage applies only to the target layout.');
  }
  const selectedEnvironment = environment as ApplicationEnvironment;
  return {
    environment: selectedEnvironment,
    layout: layout as DeploymentLayout,
    stage: stage as DeploymentStage,
    artifacts: readArtifacts(app, selectedEnvironment),
    bindings: readEnvironmentDeploymentBinding(selectedEnvironment),
  };
}

export function stackName(configuration: DeploymentConfiguration, unit: DeploymentUnit): string {
  return configuration.bindings.stacks[unit];
}

export function runtimeName(configuration: DeploymentConfiguration, suffix: string): string {
  return `${configuration.bindings.runtimePrefix}-${suffix}`;
}

export function runtimeExport(configuration: DeploymentConfiguration, suffix: string): string {
  return runtimeName(configuration, suffix);
}

export function foundationExport(configuration: DeploymentConfiguration, suffix: string): string {
  return `${configuration.bindings.foundationPrefix}-${suffix}`;
}

/** Applies the selected runtime prefix while keeping imports owned by Foundation on its prefix. */
export function bindRuntimeDefinition<T>(configuration: DeploymentConfiguration, value: T): T {
  return mapValue(value, (entry) => {
    const substitution = asRecord(entry)?.['Fn::Sub'];
    if (typeof substitution === 'string' && !substitution.includes('${')) return substitution;
    if (typeof entry !== 'string') return entry;
    let bound = entry;
    for (const suffix of foundationExportSuffixes) {
      bound = bound.replaceAll(
        `keeper-\${Environment}-${suffix}`,
        foundationExport(configuration, suffix),
      );
    }
    return bound.replaceAll('keeper-${Environment}', configuration.bindings.runtimePrefix);
  }) as T;
}

function readArtifacts(app: App, environment: ApplicationEnvironment): DeploymentArtifacts | null {
  const release = app.node.tryGetContext('release');
  if (release === undefined) return null;
  if (typeof release !== 'string' || release.length === 0) {
    throw new Error('CDK context "release" must name the captured release parameter file.');
  }
  const value = JSON.parse(readFileSync(path.resolve(release), 'utf8')) as unknown;
  const record = asRecord(value);
  const components = asRecord(record?.components);
  if (record?.schema !== 1 || components === null) {
    throw new Error('The release parameter file must be a schema 1 environment record.');
  }
  if (record.environment !== environment) {
    throw new Error('The release parameter file belongs to another environment.');
  }
  const catalogServing = component(components, 'catalogServing');
  const userCards = component(components, 'userCards');
  const recognition = component(components, 'recognition');
  const catalogIngestion = component(components, 'catalogIngestion');
  const artifacts: DeploymentArtifacts = {
    catalogServing: {
      key: required(catalogServing, 'codeKey'),
      version: required(catalogServing, 'codeVersion'),
    },
    userCards: {
      key: required(userCards, 'codeKey'),
      version: required(userCards, 'codeVersion'),
    },
    recognitionImageUri: required(recognition, 'imageUri'),
    catalogIngestionImageUri: required(catalogIngestion, 'imageUri'),
  };
  for (const image of [artifacts.recognitionImageUri, artifacts.catalogIngestionImageUri]) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error('Release image references must be pinned by SHA-256 digest.');
    }
  }
  return artifacts;
}

function component(
  components: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  const value = asRecord(components[name]);
  if (value === null) throw new Error(`The release parameter file names no ${name} component.`);
  return value;
}

function required(parameters: Readonly<Record<string, unknown>>, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === '') {
    throw new Error(`The release parameter file names no ${name}.`);
  }
  if (typeof value !== 'string') throw new Error(`The release parameter file has invalid ${name}.`);
  return value;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function mapValue(value: unknown, transform: (value: unknown) => unknown): unknown {
  if (Array.isArray(value)) return transform(value.map((entry) => mapValue(entry, transform)));
  if (typeof value !== 'object' || value === null) return transform(value);
  return transform(
    Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, mapValue(entry, transform)]),
    ),
  );
}

const foundationExportSuffixes = [
  'alarm-topic-arn',
  'artifacts-bucket',
  'catalog-reader-secret-arn',
  'catalog-writer-secret-arn',
  'database-cluster-arn',
  'database-name',
  'public-subnet-ids',
  'task-security-group-id',
  'usercards-reader-secret-arn',
  'usercards-writer-secret-arn',
  'vpc-id',
] as const;
