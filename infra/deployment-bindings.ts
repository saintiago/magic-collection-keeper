import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const deploymentUnits = [
  'foundation',
  'gateway',
  'web',
  'catalog-serving',
  'usercards',
  'recognition',
  'catalog-ingestion',
] as const;

export type DeploymentUnit = (typeof deploymentUnits)[number];
export type DeploymentEnvironment = 'development' | 'test' | 'production';

export interface EnvironmentDeploymentBinding {
  readonly foundationPrefix: string;
  readonly runtimePrefix: string;
  readonly activeUnits: readonly DeploymentUnit[];
  readonly stacks: Readonly<Record<DeploymentUnit, string>>;
  readonly compatibilityExports: Readonly<Record<string, string>>;
}

const bindingFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../deployment-bindings.json',
);

export function readEnvironmentDeploymentBinding(
  environment: DeploymentEnvironment,
): EnvironmentDeploymentBinding {
  const value = JSON.parse(readFileSync(bindingFile, 'utf8')) as unknown;
  const root = asRecord(value);
  const environments = asRecord(root?.['environments']);
  const binding = asRecord(environments?.[environment]);
  const stacks = asRecord(binding?.['stacks']);
  const activeUnits = binding?.['activeUnits'];
  const compatibilityExports = asRecord(binding?.['compatibilityExports']);
  if (
    root?.['schema'] !== 1 ||
    binding === null ||
    typeof binding['foundationPrefix'] !== 'string' ||
    typeof binding['runtimePrefix'] !== 'string' ||
    stacks === null ||
    deploymentUnits.some((unit) => typeof stacks[unit] !== 'string') ||
    !Array.isArray(activeUnits) ||
    activeUnits.some((unit) => !deploymentUnits.includes(unit as DeploymentUnit)) ||
    new Set(activeUnits).size !== activeUnits.length ||
    compatibilityExports === null ||
    Object.values(compatibilityExports).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`Deployment bindings for ${environment} are invalid.`);
  }
  return binding as unknown as EnvironmentDeploymentBinding;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
