#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { contentIdentity, deploymentUnits, readDeploymentRecord } from './deployment-record.js';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourceFile, targetFile, revision, output, configurationDirectory, githubOutput] =
    process.argv.slice(2);
  if (
    sourceFile === undefined ||
    targetFile === undefined ||
    revision === undefined ||
    output === undefined
  ) {
    throw new Error(
      'Usage: promotion-plan <source-record> <target-record> <revision> <output> <production-parameters> [github-output].',
    );
  }
  const source = readDeploymentRecord(JSON.parse(await readFile(sourceFile, 'utf8')) as unknown);
  const target = readDeploymentRecord(JSON.parse(await readFile(targetFile, 'utf8')) as unknown);
  if (source.environment !== 'test' || target.environment !== 'production') {
    throw new Error('Production promotion compares a test record with a production record.');
  }
  if (source.revision !== revision) {
    throw new Error(
      `Test evidence belongs to ${source.revision}, not selected revision ${revision}.`,
    );
  }
  const missing = deploymentUnits.filter(
    (unit) => source.components[unit]?.verification.status !== 'passed',
  );
  if (missing.length > 0) {
    throw new Error(`The test release lacks passing evidence for: ${missing.join(', ')}.`);
  }
  if (configurationDirectory === undefined) {
    throw new Error('Production parameter directory is required.');
  }
  const configurationIdentities = Object.fromEntries(
    await Promise.all(
      deploymentUnits.map(async (unit) => [
        unit,
        contentIdentity(
          JSON.parse(await readFile(`${configurationDirectory}/${unit}.json`, 'utf8')) as unknown,
        ),
      ]),
    ),
  );
  const candidates = deploymentUnits.filter((unit) => {
    const deployed = target.components[unit];
    return (
      deployed?.sourceRevision !== source.components[unit]?.sourceRevision ||
      deployed?.environmentConfigurationSha256 !== configurationIdentities[unit]
    );
  });
  const plan = {
    schema: 1,
    baseRevision: target.revision,
    sourceRevision: revision,
    changedPaths: [],
    candidates,
    reasons: Object.fromEntries(candidates.map((unit) => [unit, ['manual production promotion']])),
    productionInputs: Object.fromEntries(
      deploymentUnits.map((unit) => [unit, source.components[unit]?.inputs ?? []]),
    ),
    orchestrationChanged: false,
  };
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  if (githubOutput !== undefined) {
    const selected = new Set(candidates);
    await writeFile(
      githubOutput,
      `${deploymentUnits
        .map((unit) => `${unit.replaceAll('-', '_')}=${selected.has(unit) ? 'true' : 'false'}`)
        .join('\n')}\n`,
      { flag: 'a' },
    );
  }
}
