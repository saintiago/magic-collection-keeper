import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  emptyDeploymentRecord,
  finalizeDeploymentRecord,
  recordVerifiedComponent,
} from '../../scripts/ci/deployment-record.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('deployment shell recovery', () => {
  it('accepts CRLF preflight headers and compares the configured origin literally', async () => {
    const workflow = await readFile(
      path.join(root, '.github/workflows/deploy-gateway.yml'),
      'utf8',
    );
    const check = workflow.split('\n').find((line) => line.includes("tr -d '\\r'"));
    expect(check).toBeDefined();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-cors-'));
    try {
      await mkdir(path.join(directory, '.turbo/ci'), { recursive: true });
      const run = () =>
        exec('bash', ['-euo', 'pipefail', '-c', check!], {
          cwd: directory,
          env: { ...process.env, origin: 'https://example.com' },
        });
      for (const origin of [
        'https://example.com',
        'https://exampleXcom',
        'https://example.com.evil',
      ]) {
        await writeFile(
          path.join(directory, '.turbo/ci/headers.txt'),
          `HTTP/2 204\r\nAccess-Control-Allow-Origin: ${origin}\r\nAccess-Control-Allow-Methods: GET,POST\r\n\r\n`,
        );
        if (origin === 'https://example.com') await expect(run()).resolves.toBeDefined();
        else await expect(run()).rejects.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['test', 'production'] as const)(
    'retries %s snapshot publication after current.json fails, preserving previous releases',
    async (environment) => {
      const file = environment === 'test' ? 'ci-cd' : 'promote-production';
      const workflow = await readFile(path.join(root, `.github/workflows/${file}.yml`), 'utf8');
      const script = workflow.slice(workflow.indexOf('          release_id=')).trim();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-release-'));
      try {
        await mkdir(path.join(directory, '.turbo/ci'), { recursive: true });
        await mkdir(path.join(directory, 'bin'));
        await writeFile(
          path.join(directory, 'bin/aws'),
          `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const remote = uri => path.join(process.env.MOCK_STORE, uri.replace('s3://state/', ''));
if (args[0] === 's3api') {
  const key = args[args.indexOf('--key') + 1];
  const dest = path.join(process.env.MOCK_STORE, key);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  fs.copyFileSync(args[args.indexOf('--body') + 1], dest, fs.constants.COPYFILE_EXCL);
} else {
  const from = args[2].startsWith('s3://') ? remote(args[2]) : args[2];
  const to = args[3].startsWith('s3://') ? remote(args[3]) : args[3];
  if (process.env.FAIL_CURRENT === 'true' && to.endsWith('/current.json')) process.exit(1);
  fs.copyFileSync(from, to);
}
`,
          { mode: 0o755 },
        );
        const run = (fail = false) =>
          exec('bash', ['-euo', 'pipefail', '-c', script], {
            cwd: directory,
            env: {
              ...process.env,
              STATE_BUCKET: 'state',
              MOCK_STORE: path.join(directory, 'store'),
              FAIL_CURRENT: String(fail),
              PATH: `${directory}/bin:${process.env['PATH']}`,
            },
          });
        const component = {
          sourceRevision: '1'.repeat(40),
          stackName: `keeper-${environment}-gateway`,
          templateSha256: 'a'.repeat(64),
          configurationSha256: 'b'.repeat(64),
          environmentConfigurationSha256: 'c'.repeat(64),
          templateUri: 's3://state/template.json',
          configurationUri: 's3://state/configuration.json',
          evidenceUri: 's3://state/evidence.txt',
          artifact: { kind: 'none' as const, values: {} },
          inputs: [],
          verification: {
            status: 'passed' as const,
            checkedAt: '2026-10-03T00:00:00Z',
            evidence: ['passed'],
          },
        };
        const verified = recordVerifiedComponent(
          emptyDeploymentRecord(environment),
          'gateway',
          component,
        );
        const first = finalizeDeploymentRecord(verified, '1'.repeat(40), '2026-10-03T00:00:00Z');
        const finalFile = path.join(directory, '.turbo/ci/final.json');
        await writeFile(finalFile, JSON.stringify(first));
        await expect(run(true)).rejects.toThrow();
        const releaseFile = path.join(
          directory,
          `store/environments/${environment}/releases/${first.releaseId}.json`,
        );
        const snapshot = await readFile(releaseFile, 'utf8');
        await writeFile(
          finalFile,
          JSON.stringify(
            finalizeDeploymentRecord(verified, first.revision, '2026-10-03T01:00:00Z'),
          ),
        );
        await run();
        expect(await readFile(releaseFile, 'utf8')).toBe(snapshot);
        const current = path.join(directory, `store/environments/${environment}/current.json`);
        expect(await readFile(current, 'utf8')).toBe(snapshot);
        // New configuration evidence at the same source revision has a different release identity.
        const changed = recordVerifiedComponent(first, 'gateway', {
          ...component,
          configurationSha256: 'd'.repeat(64),
        });
        const next = finalizeDeploymentRecord(changed, first.revision, '2026-10-03T02:00:00Z');
        await writeFile(finalFile, JSON.stringify(next));
        await run();
        expect(await readFile(releaseFile, 'utf8')).toBe(snapshot);
        expect(JSON.parse(await readFile(current, 'utf8')).releaseId).toBe(next.releaseId);
        expect(next.releaseId).not.toBe(first.releaseId);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['recognition', 'catalog-ingestion'])(
    'recovers a published %s candidate on a fresh runner after deployment failure',
    async (unit) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-image-'));
      try {
        await mkdir(path.join(directory, 'bin'));
        const digest = `sha256:${'a'.repeat(64)}`;
        const inputsSha256 = 'b'.repeat(64);
        await writeFile(
          path.join(directory, 'bin/aws'),
          `#!/usr/bin/env bash
set -eu
if [[ "$2" == describe-images ]]; then
  [[ "$*" == *"imageTag=inputs-${inputsSha256}"* ]]
  if [[ "$LOOKUP" == found ]]; then echo '${digest}';
  elif [[ "$LOOKUP" == absent ]]; then echo 'ImageNotFoundException' >&2; exit 1;
  else echo 'AccessDeniedException' >&2; exit 1; fi
else echo 'test-password'; fi
`,
          { mode: 0o755 },
        );
        const output = path.join(directory, 'artifact.json');
        const githubOutput = path.join(directory, 'github-output');
        const run = (lookup: string) =>
          exec(
            'bash',
            [
              path.join(root, 'scripts/ci/image-candidate.sh'),
              `registry.example/${unit}`,
              inputsSha256,
              output,
            ],
            {
              cwd: directory,
              env: {
                ...process.env,
                LOOKUP: lookup,
                GITHUB_OUTPUT: githubOutput,
                PATH: `${directory}/bin:${process.env['PATH']}`,
              },
            },
          );
        await run('absent');
        expect(await readFile(githubOutput, 'utf8')).toBe('found=false\n');
        // Publication succeeded, then deployment failed. There is no local build or verified record.
        await writeFile(githubOutput, '');
        await run('found');
        expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
          kind: 'image',
          values: {
            imageUri: `registry.example/${unit}@${digest}`,
            digest,
            version: `inputs-${inputsSha256}`,
            inputsSha256,
          },
        });
        expect(await readFile(githubOutput, 'utf8')).toBe('found=true\n');
        await writeFile(githubOutput, '');
        await expect(run('denied')).rejects.toThrow();
        expect(await readFile(githubOutput, 'utf8')).toBe('');
        const workflow = await readFile(
          path.join(root, `.github/workflows/deploy-${unit}.yml`),
          'utf8',
        );
        expect(workflow).toContain("steps.candidate.outputs.found != 'true'");
        expect(workflow).not.toContain('keeper.manifest-sha256');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
