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
  it('persists recovery before mutation and clears it only with published verification', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-pending-'));
    try {
      await mkdir(path.join(directory, 'bin'));
      await mkdir(path.join(directory, '.turbo/ci'), { recursive: true });
      const git = (args: string[]) => exec('git', args, { cwd: directory });
      await git(['init', '-q']);
      await git(['config', 'user.email', 'test@example.com']);
      await git(['config', 'user.name', 'Test']);
      const revisions: string[] = [];
      for (const value of ['A', 'B', 'A']) {
        await writeFile(path.join(directory, 'source'), value);
        await git(['add', 'source']);
        await git(['commit', '-qm', value]);
        revisions.push((await git(['rev-parse', 'HEAD'])).stdout.trim());
      }
      const initial = { ...emptyDeploymentRecord('test'), revision: revisions[0]! };
      const remote = path.join(directory, 'store/environments/test/current.json');
      await mkdir(path.dirname(remote), { recursive: true });
      await writeFile(remote, JSON.stringify(initial));
      await writeFile(
        path.join(directory, 'bin/aws'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== 's3' || args[1] !== 'cp') throw new Error('Unexpected AWS call');
// S3 keys permit path segments longer than a local filesystem's 255-byte limit.
const resolve = value => value.startsWith('s3://state/') ? path.join(process.env.MOCK_STORE, ...value.slice('s3://state/'.length).split('/').map(part => part.length > 200 ? require('node:crypto').createHash('sha256').update(part).digest('hex') : part)) : value;
const from = resolve(args[2]);
const to = resolve(args[3]);
if (process.env.FAIL_STATE_WRITE === 'true' && args[3].startsWith('s3://') && args[3].endsWith('/current.json')) process.exit(1);
fs.mkdirSync(path.dirname(to), {recursive:true});
fs.copyFileSync(from, to);
`,
        { mode: 0o755 },
      );
      await writeFile(
        path.join(directory, 'bin/npm'),
        `#!/usr/bin/env node
require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(path.join(root, 'node_modules/tsx/dist/cli.mjs'))}, ${JSON.stringify(path.join(root, 'scripts/ci/record-deployment.ts'))}, ...process.argv.slice(5)], {stdio:'inherit'});
`,
        { mode: 0o755 },
      );
      const action = async (name: string) =>
        (await readFile(path.join(root, `.github/actions/${name}/action.yml`), 'utf8')).split(
          '      run: |\n',
        )[1]!;
      const pendingScript = await action('record-pending');
      const verifiedScript = await action('record-verified');
      const env = {
        ...process.env,
        PATH: `${directory}/bin:${process.env['PATH']}`,
        MOCK_STORE: path.join(directory, 'store'),
        STATE_BUCKET: 'state',
        RECORD_ENVIRONMENT: 'test',
        RECORD_UNIT: 'catalog-ingestion',
        RECORD_REVISION: revisions[1]!,
        RECORD_STACK: 'keeper-test-catalog-ingestion',
        RECORD_TEMPLATE: '.turbo/ci/template.json',
        RECORD_PARAMETERS: '.turbo/ci/parameters.json',
        RECORD_ENVIRONMENT_PARAMETERS: '.turbo/ci/parameters.json',
        RECORD_ARTIFACT: '.turbo/ci/artifact.json',
        RECORD_PLAN: '.turbo/ci/plan.json',
        RECORD_EVIDENCE: '.turbo/ci/evidence.txt',
      };
      const run = (script: string, extra = {}) =>
        exec('bash', ['-euo', 'pipefail', '-c', script], {
          cwd: directory,
          env: { ...env, ...extra },
        });
      // An unpersisted marker stops the job before it can mutate resources.
      await expect(
        run(`${pendingScript}\nprintf B > live`, { FAIL_STATE_WRITE: 'true' }),
      ).rejects.toThrow();
      await expect(readFile(path.join(directory, 'live'))).rejects.toThrow();
      expect(JSON.parse(await readFile(remote, 'utf8'))).toEqual(initial);
      // Deployment succeeds, then verification fails (or the runner is interrupted).
      await expect(run(`${pendingScript}\nprintf B > live\nfalse`)).rejects.toThrow();
      const failed = JSON.parse(await readFile(remote, 'utf8'));
      expect(failed.components).toEqual(initial.components);
      expect(failed.pending['catalog-ingestion'].sourceRevision).toBe(revisions[1]);
      await rm(path.join(directory, '.turbo/ci'), { recursive: true });
      env.RECORD_REVISION = revisions[2]!;
      await run(pendingScript);
      expect(
        JSON.parse(await readFile(remote, 'utf8')).pending['catalog-ingestion'].sourceRevision,
      ).toBe(revisions[2]);
      const baseImage = `node@sha256:${'a'.repeat(64)}`;
      for (const [name, value] of Object.entries({
        'template.json': {},
        'parameters.json': {},
        'artifact.json': { kind: 'image', values: { digest: 'sha256:A' } },
        'plan.json': {
          productionInputs: {},
          buildInputs: { 'catalog-ingestion': { NODE_BASE_IMAGE: baseImage } },
        },
      }))
        await writeFile(path.join(directory, '.turbo/ci', name), JSON.stringify(value));
      await writeFile(path.join(directory, '.turbo/ci/evidence.txt'), 'Restored A and verified');
      await run(`printf A > live\n${verifiedScript}`);
      const local = JSON.parse(
        await readFile(path.join(directory, '.turbo/ci/current.json'), 'utf8'),
      );
      expect(local.pending).toEqual({});
      expect(local.components['catalog-ingestion'].buildInputs).toEqual({
        NODE_BASE_IMAGE: baseImage,
      });
      const publish =
        'aws s3 cp .turbo/ci/current.json "s3://$STATE_BUCKET/environments/test/current.json"';
      await expect(run(publish, { FAIL_STATE_WRITE: 'true' })).rejects.toThrow();
      expect(JSON.parse(await readFile(remote, 'utf8')).pending['catalog-ingestion']).toBeDefined();
      await run(publish);
      expect(JSON.parse(await readFile(remote, 'utf8'))).toEqual(local);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('retries only temporary unavailable read probes and requires a successful final response', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-read-probe-'));
    try {
      await mkdir(path.join(directory, 'bin'));
      await writeFile(path.join(directory, 'request.json'), '{}');
      await writeFile(
        path.join(directory, 'bin/aws'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'lambda' || args[1] !== 'invoke') throw new Error('Unexpected AWS call');
const countFile = process.env.MOCK_COUNT;
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
const responses = process.env.MOCK_RESPONSES.split(',');
const response = responses[Math.min(count, responses.length - 1)];
fs.writeFileSync(countFile, String(count + 1));
const output = args[args.length - 1];
const statusCode = response === 'success' || response === 'function-error' ? 200 : response === 'unavailable' ? 503 : 400;
const code = response === 'unavailable' ? 'unavailable' : 'invalid-request';
fs.writeFileSync(output, JSON.stringify({statusCode, body: JSON.stringify({error: {code}})}));
process.stdout.write(JSON.stringify(response === 'function-error' ? {FunctionError: 'Unhandled'} : {}));
`,
        { mode: 0o755 },
      );
      const count = path.join(directory, 'count');
      const run = (responses: string, attempts = 6) =>
        exec(
          'bash',
          [
            path.join(root, 'scripts/ci/invoke-read-probe.sh'),
            'keeper-test-read',
            'request.json',
            'response.json',
            'invoke.json',
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PATH: `${directory}/bin:${process.env['PATH']}`,
              MOCK_COUNT: count,
              MOCK_RESPONSES: responses,
              READ_PROBE_ATTEMPTS: String(attempts),
              READ_PROBE_RETRY_SECONDS: '0',
            },
          },
        );

      await run('unavailable,unavailable,success');
      expect(await readFile(count, 'utf8')).toBe('3');
      expect(
        JSON.parse(await readFile(path.join(directory, 'response.json'), 'utf8')),
      ).toMatchObject({ statusCode: 200 });

      for (const [responses, attempts, expectedCount] of [
        ['unavailable', 3, '3'],
        ['invalid', 6, '1'],
        ['function-error', 6, '1'],
      ] as const) {
        await rm(count, { force: true });
        await expect(run(responses, attempts)).rejects.toThrow();
        expect(await readFile(count, 'utf8')).toBe(expectedCount);
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
