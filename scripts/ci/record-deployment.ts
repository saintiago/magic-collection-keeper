#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  emptyDeploymentRecord,
  finalizeDeploymentRecord,
  recordVerifiedComponent,
  readDeploymentRecord,
  type ComponentDeploymentRecord,
  type DeploymentRecord,
  type DeploymentUnit,
  deploymentUnits,
} from './deployment-record.js';

export async function recordDeployment(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const values = readFlags(argv.slice(1));
  const output = required(values, '--out');
  const record = await readOrCreateRecord(
    required(values, '--record'),
    requiredEnvironment(values, '--environment'),
  );
  if (command === 'verified') {
    const unit = requiredUnit(values, '--unit');
    const component = JSON.parse(
      await readFile(required(values, '--component'), 'utf8'),
    ) as ComponentDeploymentRecord;
    assertVerifiedComponent(component);
    await writeRecord(output, recordVerifiedComponent(record, unit, component));
    return;
  }
  if (command === 'finalize') {
    await writeRecord(
      output,
      finalizeDeploymentRecord(
        record,
        required(values, '--revision'),
        values.get('--at') ?? new Date().toISOString(),
      ),
    );
    return;
  }
  throw new Error('Use record-deployment verified or record-deployment finalize.');
}

async function readOrCreateRecord(
  file: string,
  environment: DeploymentRecord['environment'],
): Promise<DeploymentRecord> {
  try {
    const record = readDeploymentRecord(JSON.parse(await readFile(file, 'utf8')) as unknown);
    if (record.environment !== environment) {
      throw new Error(
        `The deployment record belongs to ${record.environment}, not ${environment}.`,
      );
    }
    return record;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    return emptyDeploymentRecord(environment);
  }
}

function assertVerifiedComponent(component: ComponentDeploymentRecord): void {
  if (
    !/^[0-9a-f]{40}$/.test(component.sourceRevision) ||
    component.verification?.status !== 'passed' ||
    !Array.isArray(component.inputs) ||
    component.previousRestorableVersion !== undefined
  ) {
    throw new Error(
      'The component record must describe a verified revision and omit previousRestorableVersion.',
    );
  }
}

function readFlags(argv: readonly string[]): ReadonlyMap<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) {
      throw new Error('Record flags must be supplied as --name value pairs.');
    }
    flags.set(flag, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function requiredUnit(flags: ReadonlyMap<string, string>, name: string): DeploymentUnit {
  const value = required(flags, name);
  if (!deploymentUnits.includes(value as DeploymentUnit)) {
    throw new Error(`${name} must name one deployment unit.`);
  }
  return value as DeploymentUnit;
}

function requiredEnvironment(
  flags: ReadonlyMap<string, string>,
  name: string,
): DeploymentRecord['environment'] {
  const value = required(flags, name);
  if (value !== 'test' && value !== 'production') {
    throw new Error(`${name} must be test or production.`);
  }
  return value;
}

async function writeRecord(file: string, record: DeploymentRecord): Promise<void> {
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await recordDeployment(process.argv.slice(2));
}
