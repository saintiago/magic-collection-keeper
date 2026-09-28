/**
 * Integration scope: the release acceptance evidence of docs/operations.md#release-acceptance and
 * docs/release-checklist.md.
 *
 * The evidence command runs against a prepared release directory: every byte the packaging
 * manifest names is re-verified, the recognition manifest and the deployment record have to belong
 * to the same revision, and source completion, deployment and production acceptance stay separate.
 * Deployment execution, collection migration and owner-data access remain outside this check
 * (infra/README.md#verification).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareReleaseEvidence, unresolvedChecks } from '../../scripts/release-evidence.js';
import { readRevision, type ArtifactFile } from '../../scripts/packaging-support.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const revision = readRevision(repoRoot);
const version = `0.1.0-${revision.slice(0, 12)}`;

const workspaces: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function write(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function describeFile(root: string, file: string, content: string): Promise<ArtifactFile> {
  await write(root, file, content);
  return { file, bytes: Buffer.byteLength(content), sha256: digest(content) };
}

interface ReleaseFixtureOptions {
  readonly revision?: string;
  readonly workingTree?: 'clean' | 'dirty';
  readonly recognition?: boolean;
  readonly recognitionRevision?: string;
  readonly deployment?: boolean;
}

/** A prepared release directory with the structure the packaging commands write. */
async function createRelease(options: ReleaseFixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'keeper-release-'));
  workspaces.push(root);
  const sourceRevision = options.revision ?? revision;
  const label = `0.1.0-${sourceRevision.slice(0, 12)}`;
  const backend = await describeFile(root, 'backend/api.zip', 'backend package');
  const browserEntry = await describeFile(root, 'browser/app.js', 'browser bundle');
  const browserPage = await describeFile(root, 'browser/index.html', '<!doctype html>');
  const catalog = await describeFile(root, 'catalog/job.mjs', 'catalog job');
  await write(root, 'catalog/Dockerfile', 'FROM scratch');
  await write(
    root,
    'manifest.json',
    `${JSON.stringify(
      {
        schema: 1,
        revision: sourceRevision,
        workingTree: options.workingTree ?? 'clean',
        version: label,
        node: process.version,
        platform: 'linux-x64',
        artifacts: {
          backend: { ...backend, entry: 'index.mjs' },
          browser: { directory: 'browser', files: [browserEntry, browserPage], settings: null },
          catalog: { ...catalog, dockerfile: 'catalog/Dockerfile' },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (options.recognition === true) {
    // Context files are recorded relative to the recognition context directory, like the
    // corresponding-source download the prepared engine describes.
    const contextContent = 'retained engine';
    await write(root, 'recognition/lambda_entry.py', contextContent);
    const sourceContent = 'corresponding source';
    await write(root, 'recognition/source.zip', sourceContent);
    await write(
      root,
      'recognition/manifest.json',
      `${JSON.stringify(
        {
          schema: 1,
          revision: options.recognitionRevision ?? sourceRevision,
          workingTree: 'clean',
          version: label,
          baseImage: `public.ecr.aws/lambda/python:3.12@sha256:${'0'.repeat(64)}`,
          source: {
            file: 'source.zip',
            bytes: Buffer.byteLength(sourceContent),
            sha256: digest(sourceContent),
          },
          context: [
            {
              file: 'lambda_entry.py',
              bytes: Buffer.byteLength(contextContent),
              sha256: digest(contextContent),
            },
            {
              file: 'source.zip',
              bytes: Buffer.byteLength(sourceContent),
              sha256: digest(sourceContent),
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }
  if (options.deployment === true) {
    await writeReleaseRecord(root, {});
  }
  return root;
}

/** The captured service-stack parameters a deployment writes beside the release. */
async function writeReleaseRecord(
  root: string,
  options: { readonly version?: string; readonly environment?: string },
): Promise<void> {
  const label = options.version ?? version;
  await write(
    root,
    'release.json',
    `${JSON.stringify(
      [
        { ParameterKey: 'Environment', ParameterValue: options.environment ?? 'test' },
        { ParameterKey: 'ApiCodeKey', ParameterValue: `releases/${label}/api.zip` },
        { ParameterKey: 'ApiCodeVersion', ParameterValue: 'object-version-3' },
        {
          ParameterKey: 'RecognitionImageUri',
          ParameterValue: `928374651098.dkr.ecr.us-east-1.amazonaws.com/keeper-test-recognition@sha256:${'a'.repeat(64)}`,
        },
        {
          ParameterKey: 'CatalogJobImageUri',
          ParameterValue: `928374651098.dkr.ecr.us-east-1.amazonaws.com/keeper-test-catalog@sha256:${'b'.repeat(64)}`,
        },
      ],
      null,
      2,
    )}\n`,
  );
}

function markdownLinks(markdown: string): readonly string[] {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
}

/** GitHub's heading anchor: lowercase, punctuation removed, spaces as hyphens. */
function headingSlugs(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
    (match[1] ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-'),
  );
}

describe('release acceptance evidence', () => {
  it('records verified source completion and the unperformed stages separately', async () => {
    const outDir = await createRelease();

    const { evidence, evidencePath } = await prepareReleaseEvidence({ outDir, repoRoot });

    expect(evidence.schema).toBe(1);
    expect(evidence.revision).toBe(revision);
    expect(evidence.version).toBe(version);
    expect(evidence.workingTree).toBe('clean');
    expect(evidence.stages.sourceCompletion.status).toBe('recorded');
    expect(evidence.stages.sourceCompletion.verifiedFiles).toBe(4);
    expect(evidence.stages.sourceCompletion.recognition).toBeNull();
    expect(evidence.stages.deployment.status).toBe('not-recorded');
    expect(evidence.stages.deployment.reason).toMatch(/authorization/);
    expect(evidence.stages.productionAcceptance.status).toBe('not-recorded');
    expect(evidence.stages.productionAcceptance.reason).toMatch(/migration/);
    expect(evidence.unresolvedChecks.map((check) => check.id)).toEqual([
      'provider-model-calls',
      'physical-device-acceptance',
      'collection-reconciliation',
    ]);
    expect(evidencePath).toBe(path.join(outDir, 'release-evidence.json'));
    expect(JSON.parse(await readFile(evidencePath, 'utf8'))).toEqual(evidence);
  });

  it('refuses recorded bytes that changed since packaging', async () => {
    const outDir = await createRelease();
    await write(outDir, 'catalog/job.mjs', 'tampered');

    await expect(prepareReleaseEvidence({ outDir, repoRoot })).rejects.toThrow(
      /catalog\/job\.mjs does not match/,
    );
  });

  it('refuses artifacts from another revision and a dirty working tree', async () => {
    const elsewhere = await createRelease({ revision: 'f'.repeat(40) });
    await expect(prepareReleaseEvidence({ outDir: elsewhere, repoRoot })).rejects.toThrow(
      /belongs to revision/,
    );

    const dirty = await createRelease({ workingTree: 'dirty' });
    await expect(prepareReleaseEvidence({ outDir: dirty, repoRoot })).rejects.toThrow(
      /dirty working tree/,
    );
  });

  it('records a deployment only from a release record that names this release', async () => {
    const outDir = await createRelease({ deployment: true });

    const { evidence } = await prepareReleaseEvidence({ outDir, repoRoot });

    const { deployment } = evidence.stages;
    expect(deployment.status).toBe('recorded');
    expect(deployment.reason).toBeNull();
    expect(deployment.release?.file).toBe('release.json');
    expect(deployment.environment).toBe('test');
    expect(deployment.apiCodeKey).toBe(`releases/${version}/api.zip`);
    expect(deployment.apiCodeVersion).toBe('object-version-3');
    expect(deployment.recognitionImageUri).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(deployment.catalogJobImageUri).toMatch(/@sha256:[0-9a-f]{64}$/);

    const foreign = await createRelease();
    await writeReleaseRecord(foreign, { version: '0.1.0-ffffffffffff' });
    await expect(prepareReleaseEvidence({ outDir: foreign, repoRoot })).rejects.toThrow(
      /does not name this release/,
    );
  });

  it('verifies the recognition context and the source download it carries', async () => {
    const outDir = await createRelease({ recognition: true });

    const { evidence } = await prepareReleaseEvidence({ outDir, repoRoot });
    const recognition = evidence.stages.sourceCompletion.recognition;

    expect(recognition?.version).toBe(version);
    expect(recognition?.baseImage).toMatch(/^public\.ecr\.aws\//);
    expect(recognition?.source.file).toBe('recognition/source.zip');
    expect(recognition?.contextFiles).toBe(2);

    const tampered = await createRelease({ recognition: true });
    await write(tampered, 'recognition/lambda_entry.py', 'tampered');
    await expect(prepareReleaseEvidence({ outDir: tampered, repoRoot })).rejects.toThrow(
      /does not match/,
    );

    const mixed = await createRelease({
      recognition: true,
      recognitionRevision: 'f'.repeat(40),
    });
    await expect(prepareReleaseEvidence({ outDir: mixed, repoRoot })).rejects.toThrow(
      /belongs to another release/,
    );
  });

  it('ties the checklist to requirement sections, repository commands and recorded checks', async () => {
    const checklistFile = 'docs/release-checklist.md';
    const checklist = await readFile(path.join(repoRoot, checklistFile), 'utf8');

    for (const target of markdownLinks(checklist)) {
      expect(target, 'The checklist links an external page').not.toMatch(/^[a-z]+:\/\//);
      const [file = '', anchor] = target.split('#');
      const linked =
        file.length === 0
          ? path.join(repoRoot, checklistFile)
          : path.resolve(repoRoot, path.dirname(checklistFile), file);
      expect(existsSync(linked), `The checklist links a missing file: ${target}`).toBe(true);
      if (anchor !== undefined && anchor.length > 0) {
        expect(headingSlugs(await readFile(linked, 'utf8')), `missing ${target}`).toContain(anchor);
      }
    }

    const { scripts } = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    for (const match of checklist.matchAll(/npm run ([a-z0-9:-]+)/g)) {
      expect(
        scripts[match[1] ?? ''],
        `The checklist names the unknown command ${match[1]}`,
      ).toBeDefined();
    }
    for (const match of checklist.matchAll(/`((?:tests|src|infra|scripts)\/[\w./-]+)`/g)) {
      expect(
        existsSync(path.join(repoRoot, match[1] ?? '')),
        `The checklist names the missing path ${match[1]}`,
      ).toBe(true);
    }
    for (const check of unresolvedChecks) {
      expect(checklist).toContain(check.id);
    }
  });
});
