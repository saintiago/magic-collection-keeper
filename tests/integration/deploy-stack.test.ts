import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { emptyDeploymentRecord } from '../../scripts/ci/deployment-record.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('stack change-set execution', () => {
  it.each([
    {
      name: 'executes an output-only Foundation update',
      description: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', Changes: [] },
      outcome: 'deployed',
    },
    ...["The submitted information didn't contain changes.", 'No updates are to be performed.'].map(
      (StatusReason) => ({
        name: `treats AWS no-changes response as a no-op: ${StatusReason}`,
        description: {
          Status: 'FAILED',
          ExecutionStatus: 'UNAVAILABLE',
          StatusReason,
          Changes: [],
        },
        outcome: 'no-op',
      }),
    ),
    {
      name: 'rejects an unrelated preparation failure',
      description: { Status: 'FAILED', StatusReason: 'Invalid template', Changes: [] },
      error: 'change-set preparation failed: Invalid template',
    },
    {
      name: 'rejects a change set unavailable for execution',
      description: { Status: 'CREATE_COMPLETE', ExecutionStatus: 'OBSOLETE', Changes: [] },
      error: 'change set is not executable: OBSOLETE',
    },
    {
      name: 'rejects replacement of a retained Foundation resource',
      description: {
        Status: 'CREATE_COMPLETE',
        ExecutionStatus: 'AVAILABLE',
        Changes: [
          {
            ResourceChange: {
              Action: 'Modify',
              LogicalResourceId: 'Database',
              ResourceType: 'AWS::RDS::DBCluster',
              Replacement: 'True',
            },
          },
        ],
      },
      error: 'Refusing destructive change to retained resource Database',
    },
  ])('$name', async (scenario) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-deploy-stack-'));
    try {
      await writeFile(
        path.join(directory, 'aws'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] !== 'cloudformation') throw new Error('Unexpected AWS service');
switch (args[1]) {
  case 'describe-stacks':
    console.log(JSON.stringify({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] }));
    break;
  case 'describe-change-set':
    process.stdout.write(fs.readFileSync('description.json', 'utf8'));
    break;
  case 'create-change-set':
  case 'execute-change-set':
  case 'wait':
    break;
  default: throw new Error('Unexpected AWS operation');
}
`,
        { mode: 0o755 },
      );
      for (const [name, value] of Object.entries({
        'description.json': scenario.description,
        'template.json': {
          Resources: { Database: { Type: 'AWS::RDS::DBCluster', DeletionPolicy: 'Retain' } },
          Outputs: { Compatibility: { Value: 'retained-reference' } },
        },
        'parameters.json': {},
        'current.json': emptyDeploymentRecord('test'),
      })) {
        await writeFile(path.join(directory, name), JSON.stringify(value));
      }
      const deployment = exec(
        process.execPath,
        [
          path.join(root, 'node_modules/tsx/dist/cli.mjs'),
          path.join(root, 'scripts/ci/deploy-stack.ts'),
          '--stack',
          'keeper-test-foundation',
          '--template',
          'template.json',
          '--parameters',
          'parameters.json',
          '--current-record',
          'current.json',
          '--revision',
          '1'.repeat(40),
        ],
        { cwd: directory, env: { ...process.env, PATH: `${directory}:${process.env['PATH']}` } },
      );
      if ('error' in scenario) await expect(deployment).rejects.toThrow(scenario.error);
      else expect((await deployment).stdout.trim().split('\n').at(-1)).toBe(scenario.outcome);

      const calls = (await readFile(path.join(directory, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.map((args) => args[1])).toEqual([
        'describe-stacks',
        'create-change-set',
        'describe-change-set',
        ...('outcome' in scenario && scenario.outcome === 'deployed'
          ? ['execute-change-set', 'wait']
          : []),
      ]);
      if ('outcome' in scenario && scenario.outcome === 'deployed') {
        expect(calls.at(-1)).toContain('stack-update-complete');
        expect(calls[3]).toContain(calls[1]![5]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
