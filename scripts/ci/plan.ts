#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  contentIdentity,
  deploymentUnits,
  readDeploymentRecord,
  type DeploymentRecord,
} from './deployment-record.js';
import { collectProductionInputs, planDeployments, readStackInputMapping } from './planner.js';
import { assertPinnedNodeBaseImage } from './image-inputs.js';
import { readEnvironmentDeploymentBinding } from '../../infra/deployment-bindings.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface CommandLine {
  readonly base: string;
  readonly head: string;
  readonly record: string | null;
  readonly out: string;
  readonly githubOutput: string | null;
  readonly configurationDirectory: string | null;
  readonly catalogNodeBaseImage?: string;
  readonly environment: 'test' | 'production';
}

export async function createDeploymentPlan(command: CommandLine, root = repoRoot): Promise<void> {
  if (command.catalogNodeBaseImage !== undefined)
    assertPinnedNodeBaseImage(command.catalogNodeBaseImage);
  const deployedRecord = await optionalRecord(command.record);
  const base =
    deployedRecord?.revision === zeroRevision
      ? command.base
      : (deployedRecord?.revision ?? command.base);
  const changedPaths = await diffPaths(base, command.head, root);
  const mapping = await readStackInputMapping(path.join(root, 'scripts/ci/stack-inputs.json'));
  const binding = readEnvironmentDeploymentBinding(command.environment);
  const productionInputs = await collectProductionInputs(root);
  const configurationIdentities = await readConfigurationIdentities(
    command.configurationDirectory,
    binding.activeUnits,
  );
  const plan = planDeployments({
    baseRevision: base,
    sourceRevision: command.head,
    changedPaths,
    mapping,
    productionInputs,
    configurationIdentities,
    buildInputs:
      command.catalogNodeBaseImage === undefined
        ? {}
        : {
            'catalog-ingestion': { NODE_BASE_IMAGE: command.catalogNodeBaseImage },
          },
    previousProductionInputs: await collectInputsAtRevision(root, base),
    targetUnits: binding.activeUnits,
    ...(deployedRecord === undefined ? {} : { deployedRecord }),
  });
  await writeFile(command.out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  if (command.githubOutput !== null) {
    const selected = new Set(plan.candidates);
    const outputs = deploymentUnits.map(
      (unit) => `${unit.replaceAll('-', '_')}=${selected.has(unit) ? 'true' : 'false'}`,
    );
    outputs.push(`plan=${JSON.stringify(command.out)}`);
    await writeFile(command.githubOutput, `${outputs.join('\n')}\n`, { flag: 'a' });
  }
}

async function diffPaths(base: string, head: string, root: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-status', '--find-renames', `${base}..${head}`],
    { cwd: root },
  );
  const files = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split('\t');
    const status = fields[0] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      if (fields[1] !== undefined) files.add(fields[1]);
      if (fields[2] !== undefined) files.add(fields[2]);
    } else if (fields[1] !== undefined) {
      files.add(fields[1]);
    }
  }
  return [...files];
}

/** Inspect the base tree without running its scripts or changing the active checkout. */
async function collectInputsAtRevision(root: string, revision: string) {
  assertRevision(revision);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-plan-'));
  const tree = path.join(directory, 'tree');
  try {
    await execFileAsync(
      'git',
      ['archive', '--format=tar', `--output=${directory}/base.tar`, revision],
      { cwd: root },
    );
    await mkdir(tree);
    await execFileAsync('tar', ['-xf', `${directory}/base.tar`, '-C', tree]);
    return await collectProductionInputs(tree);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function optionalRecord(file: string | null): Promise<DeploymentRecord | undefined> {
  if (file === null) return undefined;
  try {
    return readDeploymentRecord(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return undefined;
    throw cause;
  }
}

function readCommandLine(argv: readonly string[]): CommandLine {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith('--')) {
      throw new Error('Planning flags must be supplied as --name value pairs.');
    }
    values.set(flag, value);
  }
  const base = required(values, '--base');
  const head = required(values, '--head');
  assertRevision(base);
  assertRevision(head);
  return {
    base,
    head,
    environment: deploymentEnvironment(required(values, '--environment')),
    record: values.get('--record') ?? null,
    out: values.get('--out') ?? 'artifacts/deployment-plan.json',
    githubOutput: values.get('--github-output') ?? process.env['GITHUB_OUTPUT'] ?? null,
    configurationDirectory: values.get('--configuration-dir') ?? null,
    ...(values.has('--catalog-node-base-image')
      ? { catalogNodeBaseImage: values.get('--catalog-node-base-image')! }
      : {}),
  };
}

function deploymentEnvironment(value: string): 'test' | 'production' {
  if (value !== 'test' && value !== 'production') {
    throw new Error('--environment must be test or production.');
  }
  return value;
}

async function readConfigurationIdentities(
  directory: string | null,
  units: readonly (typeof deploymentUnits)[number][],
): Promise<Partial<Record<(typeof deploymentUnits)[number], string>>> {
  if (directory === null) return {};
  return Object.fromEntries(
    await Promise.all(
      units.map(async (unit) => {
        const value = JSON.parse(
          await readFile(path.join(directory, `${unit}.json`), 'utf8'),
        ) as unknown;
        return [unit, contentIdentity(value)] as const;
      }),
    ),
  );
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) throw new Error(`${flag} is required.`);
  return value;
}

function assertRevision(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Planner revisions must be full Git IDs.');
}

const zeroRevision = '0000000000000000000000000000000000000000';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createDeploymentPlan(readCommandLine(process.argv.slice(2)));
}
