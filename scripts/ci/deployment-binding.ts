#!/usr/bin/env node

import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  deploymentUnits,
  readEnvironmentDeploymentBinding,
  type DeploymentUnit,
} from '../../infra/deployment-bindings.js';

interface CommandLine {
  readonly environment: 'test' | 'production';
  readonly unit: DeploymentUnit;
  readonly githubOutput: string | null;
}

export async function writeDeploymentBinding(command: CommandLine): Promise<void> {
  const binding = readEnvironmentDeploymentBinding(command.environment);
  if (!binding.activeUnits.includes(command.unit)) {
    throw new Error(`${command.unit} is not an active ${command.environment} deployment target.`);
  }
  const outputs = [
    `stack_name=${binding.stacks[command.unit]}`,
    `foundation_stack_name=${binding.stacks.foundation}`,
    `gateway_stack_name=${binding.stacks.gateway}`,
    `recognition_stack_name=${binding.stacks.recognition}`,
    `runtime_prefix=${binding.runtimePrefix}`,
    `foundation_prefix=${binding.foundationPrefix}`,
  ];
  const text = `${outputs.join('\n')}\n`;
  if (command.githubOutput === null) await writeFile('/dev/stdout', text);
  else await appendFile(command.githubOutput, text);
}

function readCommandLine(argv: readonly string[]): CommandLine {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) {
      throw new Error('Binding flags must be supplied as --name value pairs.');
    }
    values.set(flag, value);
  }
  const environment = required(values, '--environment');
  const unit = required(values, '--unit');
  if (environment !== 'test' && environment !== 'production') {
    throw new Error('--environment must be test or production.');
  }
  if (!deploymentUnits.includes(unit as DeploymentUnit)) {
    throw new Error(`--unit must be one of ${deploymentUnits.join(', ')}.`);
  }
  return {
    environment,
    unit: unit as DeploymentUnit,
    githubOutput: values.get('--github-output') ?? process.env['GITHUB_OUTPUT'] ?? null,
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new Error(`${flag} is required.`);
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeDeploymentBinding(readCommandLine(process.argv.slice(2)));
}
