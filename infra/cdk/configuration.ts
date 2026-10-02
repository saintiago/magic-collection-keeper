import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { App } from 'aws-cdk-lib';

import {
  applicationEnvironments,
  type ApplicationEnvironment,
} from '../../src/application/index.js';

export const deploymentLayouts = ['legacy', 'target'] as const;
export type DeploymentLayout = (typeof deploymentLayouts)[number];

export interface DeploymentConfiguration {
  readonly environment: ApplicationEnvironment;
  readonly layout: DeploymentLayout;
  readonly artifacts: DeploymentArtifacts | null;
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
  return {
    environment: environment as ApplicationEnvironment,
    layout: layout as DeploymentLayout,
    artifacts: readArtifacts(app, environment as ApplicationEnvironment),
  };
}

export function stackName(environment: ApplicationEnvironment, unit: string): string {
  return `keeper-${environment}-${unit}`;
}

function readArtifacts(app: App, environment: ApplicationEnvironment): DeploymentArtifacts | null {
  const release = app.node.tryGetContext('release');
  if (release === undefined) return null;
  if (typeof release !== 'string' || release.length === 0) {
    throw new Error('CDK context "release" must name the captured release parameter file.');
  }
  const value = JSON.parse(readFileSync(path.resolve(release), 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('The release parameter file must be a JSON array.');
  const parameters = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Readonly<Record<string, unknown>>;
    if (typeof record.ParameterKey === 'string' && typeof record.ParameterValue === 'string') {
      parameters.set(record.ParameterKey, record.ParameterValue);
    }
  }
  if (parameters.get('Environment') !== environment) {
    throw new Error('The release parameter file belongs to another environment.');
  }
  const artifacts: DeploymentArtifacts = {
    catalogServing: {
      key: required(parameters, 'CatalogServingCodeKey'),
      version: required(parameters, 'CatalogServingCodeVersion'),
    },
    userCards: {
      key: required(parameters, 'UserCardsCodeKey'),
      version: required(parameters, 'UserCardsCodeVersion'),
    },
    recognitionImageUri: required(parameters, 'RecognitionImageUri'),
    catalogIngestionImageUri: required(parameters, 'CatalogJobImageUri'),
  };
  for (const image of [artifacts.recognitionImageUri, artifacts.catalogIngestionImageUri]) {
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error('Release image references must be pinned by SHA-256 digest.');
    }
  }
  return artifacts;
}

function required(parameters: ReadonlyMap<string, string>, name: string): string {
  const value = parameters.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`The release parameter file names no ${name}.`);
  }
  return value;
}
