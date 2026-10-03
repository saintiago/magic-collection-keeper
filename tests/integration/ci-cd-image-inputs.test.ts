import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { imageInputsIdentity } from '../../scripts/ci/image-inputs.js';
import { packageArtifacts } from '../../scripts/package-artifacts.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('image content comparison', () => {
  it('keeps identical Catalog inputs across revisions and detects job, Dockerfile and base changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-catalog-inputs-'));
    try {
      const args = { NODE_BASE_IMAGE: `node@sha256:${'a'.repeat(64)}` };
      const first = await packageArtifacts({ outDir: directory, revision: '1'.repeat(40) });
      const context = path.join(directory, 'catalog-ingestion');
      const identity = await imageInputsIdentity(context, args);
      const second = await packageArtifacts({ outDir: directory, revision: '2'.repeat(40) });
      expect(first.manifest.version).not.toBe(second.manifest.version);
      expect(await imageInputsIdentity(context, args)).toBe(identity);
      // Unrelated artifact output does not change the ingestion candidate.
      await writeFile(path.join(directory, 'manifest.json'), '{"revision":"other"}');
      expect(await imageInputsIdentity(context, args)).toBe(identity);
      expect(
        await imageInputsIdentity(context, { NODE_BASE_IMAGE: `node@sha256:${'b'.repeat(64)}` }),
      ).not.toBe(identity);
      for (const file of ['job.mjs', 'Dockerfile']) {
        const target = path.join(context, file);
        const original = await readFile(target);
        await writeFile(target, Buffer.concat([original, Buffer.from('\nchanged')]));
        expect(await imageInputsIdentity(context, args)).not.toBe(identity);
        await writeFile(target, original);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('compares Recognition source contents across fresh checkout timestamps and provenance labels', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keeper-recognition-inputs-'));
    try {
      await writeFile(
        path.join(directory, 'Dockerfile'),
        'FROM runtime@sha256:pinned\nCOPY source.zip ./',
      );
      const writeArchive = async (year: number, source = 'engine source') => {
        const zip = new JSZip();
        zip.file('keeper/engine.py', source, { date: new Date(`${year}-01-01T00:00:00Z`) });
        await writeFile(
          path.join(directory, 'source.zip'),
          await zip.generateAsync({ type: 'nodebuffer' }),
        );
        await writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify({ revision: String(year), version: String(year) }),
        );
      };
      await writeArchive(2025);
      const originalArchive = await readFile(path.join(directory, 'source.zip'));
      const identity = await imageInputsIdentity(directory);
      await writeArchive(2026);
      expect(await readFile(path.join(directory, 'source.zip'))).not.toEqual(originalArchive);
      expect(await imageInputsIdentity(directory)).toBe(identity);
      await writeArchive(2026, 'changed engine source');
      expect(await imageInputsIdentity(directory)).not.toBe(identity);
      await writeArchive(2026);
      await writeFile(path.join(directory, 'model.onnx'), 'changed model');
      expect(await imageInputsIdentity(directory)).not.toBe(identity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('finalization workflow gates', () => {
  it.each(['ci-cd', 'promote-production'])(
    'requires successful prerequisites in %s while allowing unselected stacks',
    async (workflow) => {
      const source = await readFile(path.join(root, `.github/workflows/${workflow}.yml`), 'utf8');
      const job = source.slice(source.indexOf('  finalize:'));
      const dependencies = job
        .match(/needs:\s*\[([^\]]+)\]/)![1]!
        .split(',')
        .map((name) => name.trim());
      const condition = job.match(/if: \$\{\{ (.+) \}\}/)![1]!;
      const evaluate = (
        results: Record<string, string>,
        cancelled = false,
        event = 'push',
        enabled = 'true',
      ) => {
        const needs = Object.fromEntries(
          dependencies.map((name) => [name, { result: results[name] ?? 'skipped' }]),
        );
        return runInNewContext(condition.replaceAll('needs.*.result', 'results'), {
          needs,
          results: Object.values(needs).map((value) => value.result),
          cancelled: () => cancelled,
          contains: (values: string[], value: string) => values.includes(value),
          github: { event_name: event },
          vars: { DEPLOYMENT_ENABLED: enabled },
        });
      };
      const success = { ci: 'success', plan: 'success' };
      expect(evaluate(success)).toBe(true);
      expect(evaluate({ ...success, web: 'success' })).toBe(true);
      expect(evaluate({ ...success, plan: 'skipped' })).toBe(false);
      expect(evaluate({ ...success, plan: 'failure' })).toBe(false);
      expect(evaluate({ ...success, web: 'failure' })).toBe(false);
      expect(evaluate(success, true)).toBe(false);
      if (workflow === 'ci-cd') {
        expect(dependencies).toContain('ci');
        expect(evaluate({ ci: 'failure' })).toBe(false);
        expect(evaluate({ ...success, ci: 'failure' })).toBe(false);
        expect(evaluate(success, false, 'pull_request')).toBe(false);
        expect(evaluate(success, false, 'push', 'false')).toBe(false);
      }
    },
  );
});
