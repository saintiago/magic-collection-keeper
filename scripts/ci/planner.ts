import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { build, type BuildOptions } from 'esbuild';

import {
  deploymentUnits,
  type DeploymentRecord,
  type DeploymentUnit,
} from './deployment-record.js';

export interface StackInputMapping {
  readonly schema: 1;
  readonly stacks: Readonly<
    Record<
      DeploymentUnit,
      { readonly cdkStack: string; readonly unit: string; readonly workflow: string }
    >
  >;
  readonly rules: readonly {
    readonly paths: readonly string[];
    readonly stacks: readonly DeploymentUnit[];
  }[];
  readonly orchestrationOnly: readonly string[];
  readonly validationOnly: readonly string[];
  readonly replanDependents: Partial<Record<DeploymentUnit, readonly DeploymentUnit[]>>;
}

export interface DeploymentPlan {
  readonly schema: 1;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly changedPaths: readonly string[];
  readonly candidates: readonly DeploymentUnit[];
  readonly reasons: Partial<Record<DeploymentUnit, readonly string[]>>;
  readonly productionInputs: Partial<Record<DeploymentUnit, readonly string[]>>;
  readonly orchestrationChanged: boolean;
}

export interface PlanOptions {
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly changedPaths: readonly string[];
  readonly mapping: StackInputMapping;
  readonly productionInputs: Partial<Record<DeploymentUnit, readonly string[]>>;
  readonly previousProductionInputs?: Partial<Record<DeploymentUnit, readonly string[]>>;
  readonly deployedRecord?: DeploymentRecord;
  readonly configurationIdentities?: Partial<Record<DeploymentUnit, string>>;
}

/**
 * Selects candidate deployments. Actual content/template/configuration comparison happens after
 * reproducible packaging; this phase makes sure no potentially affected unit is silently skipped.
 */
export function planDeployments(options: PlanOptions): DeploymentPlan {
  const candidates = new Set<DeploymentUnit>();
  const reasons = new Map<DeploymentUnit, Set<string>>();
  let orchestrationChanged = false;
  const deployedInputs = Object.fromEntries(
    deploymentUnits.map((unit) => [unit, options.deployedRecord?.components[unit]?.inputs ?? []]),
  ) as Record<DeploymentUnit, readonly string[]>;

  for (const changed of [...new Set(options.changedPaths)].sort()) {
    let classified = false;
    for (const rule of options.mapping.rules) {
      if (!rule.paths.some((pattern) => matches(pattern, changed))) continue;
      classified = true;
      for (const unit of rule.stacks) addReason(candidates, reasons, unit, changed);
    }
    for (const unit of deploymentUnits) {
      const current = options.productionInputs[unit] ?? [];
      const previous = [
        ...deployedInputs[unit],
        ...(options.previousProductionInputs?.[unit] ?? []),
      ];
      if (!current.includes(changed) && !previous.includes(changed)) continue;
      classified = true;
      addReason(candidates, reasons, unit, changed);
    }
    if (options.mapping.orchestrationOnly.some((pattern) => matches(pattern, changed))) {
      classified = true;
      orchestrationChanged = true;
    }
    if (options.mapping.validationOnly.some((pattern) => matches(pattern, changed))) {
      classified = true;
    }
    if (!classified) {
      throw new Error(
        `Cannot classify changed input ${changed}; update scripts/ci/stack-inputs.json explicitly.`,
      );
    }
  }

  for (const unit of deploymentUnits) {
    const component = options.deployedRecord?.components[unit];
    if (component !== undefined && component.sourceRevision !== options.baseRevision) {
      addReason(candidates, reasons, unit, '[component differs from finalized baseline]');
    }
    const desired = options.configurationIdentities?.[unit];
    if (
      desired !== undefined &&
      desired !== options.deployedRecord?.components[unit]?.environmentConfigurationSha256
    ) {
      addReason(candidates, reasons, unit, '[environment configuration changed]');
    }
  }
  let addedDependent = true;
  while (addedDependent) {
    addedDependent = false;
    for (const provider of deploymentUnits) {
      if (!candidates.has(provider)) continue;
      for (const dependent of options.mapping.replanDependents[provider] ?? []) {
        if (!candidates.has(dependent)) addedDependent = true;
        addReason(candidates, reasons, dependent, `[provider ${provider} replanned]`);
      }
    }
  }

  return {
    schema: 1,
    baseRevision: options.baseRevision,
    sourceRevision: options.sourceRevision,
    changedPaths: [...new Set(options.changedPaths)].sort(),
    candidates: deploymentUnits.filter((unit) => candidates.has(unit)),
    reasons: Object.fromEntries([...reasons].map(([unit, paths]) => [unit, [...paths].sort()])),
    productionInputs: Object.fromEntries(
      deploymentUnits
        .filter((unit) => options.productionInputs[unit] !== undefined)
        .map((unit) => [unit, [...new Set(options.productionInputs[unit])].sort()]),
    ),
    orchestrationChanged,
  };
}

export async function readStackInputMapping(file: string): Promise<StackInputMapping> {
  const value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const record = asRecord(value);
  if (record?.['schema'] !== 1) throw new Error('The stack input mapping must have schema 1.');
  const stacks = asRecord(record['stacks']);
  if (stacks === null || deploymentUnits.some((unit) => asRecord(stacks[unit]) === null)) {
    throw new Error('The stack input mapping must describe every deployment unit.');
  }
  return value as StackInputMapping;
}

/** Resolves the source graph of each bundled production entry point with the real build options. */
export async function collectProductionInputs(
  root: string,
): Promise<Partial<Record<DeploymentUnit, readonly string[]>>> {
  const entries: readonly [DeploymentUnit, BuildOptions][] = [
    ['web', bundleOptions(root, 'browser', path.join(root, 'src/application/entrypoints/web.ts'))],
    [
      'catalog-serving',
      bundleOptions(
        root,
        'node',
        path.join(root, 'src/application/entrypoints/catalog-serving.ts'),
      ),
    ],
    [
      'usercards',
      bundleOptions(root, 'node', path.join(root, 'src/application/entrypoints/usercards.ts')),
    ],
    [
      'catalog-ingestion',
      bundleOptions(
        root,
        'node',
        path.join(root, 'src/application/entrypoints/catalog-ingestion.ts'),
      ),
    ],
    ['recognition', bundleOptions(root, 'node', path.join(root, 'scripts/package-recognition.ts'))],
    ['web', bundleOptions(root, 'node', path.join(root, 'scripts/prepare-recognition.ts'))],
  ];
  const results = await Promise.all(
    entries.map(async ([unit, options]) => {
      const result = await build(options);
      const inputs = Object.keys(result.metafile?.inputs ?? {}).map((file) =>
        normalize(path.relative(root, path.resolve(root, file))),
      );
      return [unit, inputs.filter((file) => !file.startsWith('node_modules/')).sort()] as const;
    }),
  );
  const collected: Partial<Record<DeploymentUnit, Set<string>>> = {};
  for (const [unit, inputs] of results) {
    const unitInputs = collected[unit] ?? new Set<string>();
    for (const input of inputs) unitInputs.add(input);
    collected[unit] = unitInputs;
  }
  for (const input of [
    'src/recognition/python/requirements-converter.txt',
    'src/recognition/python/requirements-visual.txt',
    'src/recognition/python/scripts/browser_assets.py',
    'src/recognition/python/scripts/convert_ocr.py',
    'src/recognition/python/scripts/prepare.py',
  ]) {
    (collected.web ??= new Set()).add(input);
  }
  return Object.fromEntries(
    Object.entries(collected).map(([unit, inputs]) => [unit, [...inputs].sort()]),
  );
}

export function matches(pattern: string, file: string): boolean {
  const expression = pattern
    .split('**')
    .map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(normalize(file));
}

function bundleOptions(root: string, platform: 'browser' | 'node', entry: string): BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    // Lockfile/package changes already select all consumers. Resolve only repository source so
    // the base graph also works when a dependency has been removed from the current install.
    packages: 'external',
    format: 'esm',
    platform,
    target: platform === 'node' ? 'node24' : 'es2022',
    mainFields: platform === 'node' ? ['module', 'main'] : ['browser', 'module', 'main'],
    metafile: true,
    write: false,
    logLevel: 'silent',
  };
}

function addReason(
  candidates: Set<DeploymentUnit>,
  reasons: Map<DeploymentUnit, Set<string>>,
  unit: DeploymentUnit,
  file: string,
): void {
  candidates.add(unit);
  const paths = reasons.get(unit) ?? new Set<string>();
  paths.add(file);
  reasons.set(unit, paths);
}

function normalize(file: string): string {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
