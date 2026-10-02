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
  readonly recognitionWorkingTree?: 'clean' | 'dirty';
  /** How the packaged browser manifest and the recognition manifest's browser assets relate. */
  readonly browserAssets?: 'packaged' | 'omitted' | 'mismatched' | 'foreign-runtime';
  readonly deployment?: boolean;
}

/** A prepared release directory with the structure the packaging commands write. */
async function createRelease(options: ReleaseFixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'keeper-release-'));
  workspaces.push(root);
  const sourceRevision = options.revision ?? revision;
  const label = `0.1.0-${sourceRevision.slice(0, 12)}`;
  const catalogServing = await describeFile(
    root,
    'catalog-serving/api.zip',
    'catalog serving package',
  );
  const userCards = await describeFile(root, 'usercards/api.zip', 'usercards package');
  const browserEntry = await describeFile(root, 'browser/app.js', 'browser bundle');
  const browserPage = await describeFile(root, 'browser/index.html', '<!doctype html>');
  const catalog = await describeFile(root, 'catalog-ingestion/job.mjs', 'catalog job');
  const catalogDockerfile = await describeFile(
    root,
    'catalog-ingestion/Dockerfile',
    'FROM scratch',
  );
  const browserFiles: ArtifactFile[] = [browserEntry, browserPage];
  const recognition =
    options.recognition === true
      ? await createRecognitionFixture(root, browserFiles, options, label)
      : null;
  await write(
    root,
    'manifest.json',
    `${JSON.stringify(
      {
        schema: 2,
        revision: sourceRevision,
        workingTree: options.workingTree ?? 'clean',
        version: label,
        node: process.version,
        platform: 'linux-x64',
        artifacts: {
          catalogServing: { ...catalogServing, entry: 'index.mjs' },
          userCards: { ...userCards, entry: 'index.mjs' },
          browser: { directory: 'browser', files: browserFiles, settings: null },
          catalogIngestion: { ...catalog, dockerfile: catalogDockerfile },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (recognition !== null) {
    await write(root, 'recognition/manifest.json', `${JSON.stringify(recognition, null, 2)}\n`);
  }
  if (options.deployment === true) {
    await writeReleaseRecord(root, {});
  }
  return root;
}

/**
 * The recognition half of the fixture: the image context, its corresponding-source download, the
 * engine identities and the browser runtime/model assets the recognition manifest publishes. The
 * packaged browser manifest carries the same assets unless the case omits them.
 */
async function createRecognitionFixture(
  root: string,
  browserFiles: ArtifactFile[],
  options: ReleaseFixtureOptions,
  label: string,
): Promise<unknown> {
  const assetsMode = options.browserAssets ?? 'packaged';
  // Context files are recorded relative to the recognition context directory, like the
  // corresponding-source download the prepared engine describes.
  const contextContent = 'retained engine';
  await write(root, 'recognition/lambda_entry.py', contextContent);
  const sourceContent = 'corresponding source';
  await write(root, 'recognition/source.zip', sourceContent);
  const runtimeContent = 'browser runtime module';
  const visualContent = 'browser visual model';
  const runtime: { version: string; file: string; bytes: number; sha256: string } = {
    version: '1.29.0',
    file: 'ort-wasm-simd-threaded.mjs',
    bytes: Buffer.byteLength(runtimeContent),
    sha256: digest(runtimeContent),
  };
  const assets: ArtifactFile[] = [];
  const runtimeFile = `browser/vendor/ort/${runtime.file}`;
  const visualFile = `browser/vendor/visual/${digest(visualContent)}.onnx`;
  const vendorFiles = [
    { file: runtimeFile, content: runtimeContent },
    { file: visualFile, content: visualContent },
  ] as const;
  for (const vendor of vendorFiles) {
    if (assetsMode !== 'omitted') {
      await write(root, vendor.file, vendor.content);
      browserFiles.push({
        file: vendor.file,
        bytes: Buffer.byteLength(vendor.content),
        sha256: digest(vendor.content),
      });
    }
    const recorded = {
      file: vendor.file,
      bytes: Buffer.byteLength(vendor.content),
      sha256: digest(vendor.content),
    };
    assets.push(
      assetsMode === 'mismatched' && vendor.file === visualFile
        ? { ...recorded, sha256: 'f'.repeat(64) }
        : recorded,
    );
  }
  if (assetsMode === 'foreign-runtime') {
    runtime.sha256 = 'f'.repeat(64);
  }
  return {
    schema: 1,
    revision: options.recognitionRevision ?? options.revision ?? revision,
    workingTree: options.recognitionWorkingTree ?? 'clean',
    version: label,
    baseImage: `public.ecr.aws/lambda/python:3.12@sha256:${'0'.repeat(64)}`,
    source: {
      file: 'source.zip',
      bytes: Buffer.byteLength(sourceContent),
      sha256: digest(sourceContent),
    },
    browser: { runtime, assets },
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
  };
}

/** The captured service-stack parameters a deployment writes beside the release. */
async function writeReleaseRecord(
  root: string,
  options: {
    readonly version?: string;
    readonly environment?: string;
    /** Whether the captured parameters name the indexing image, as a deployment of this release does. */
  },
): Promise<void> {
  const label = options.version ?? version;
  const parameters = [
    { ParameterKey: 'Environment', ParameterValue: options.environment ?? 'test' },
    {
      ParameterKey: 'CatalogServingCodeKey',
      ParameterValue: `releases/${label}/catalog-serving.zip`,
    },
    { ParameterKey: 'CatalogServingCodeVersion', ParameterValue: 'object-version-3' },
    {
      ParameterKey: 'UserCardsCodeKey',
      ParameterValue: `releases/${label}/usercards.zip`,
    },
    { ParameterKey: 'UserCardsCodeVersion', ParameterValue: 'object-version-4' },
    {
      ParameterKey: 'RecognitionImageUri',
      ParameterValue: `928374651098.dkr.ecr.us-east-1.amazonaws.com/keeper-test-recognition@sha256:${'a'.repeat(64)}`,
    },
    {
      ParameterKey: 'CatalogJobImageUri',
      ParameterValue: `928374651098.dkr.ecr.us-east-1.amazonaws.com/keeper-test-catalog@sha256:${'b'.repeat(64)}`,
    },
  ];
  await write(root, 'release.json', `${JSON.stringify(parameters, null, 2)}\n`);
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
    // Two serving zips, browser files, and the ingestion module/Dockerfile are independent bytes.
    expect(evidence.stages.sourceCompletion.verifiedFiles).toBe(6);
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
    await write(outDir, 'catalog-ingestion/job.mjs', 'tampered');

    await expect(prepareReleaseEvidence({ outDir, repoRoot })).rejects.toThrow(
      /catalog-ingestion\/job\.mjs does not match/,
    );
  });

  it('verifies the catalog-job container definition as release bytes', async () => {
    for (const dockerfile of ['catalog-ingestion/Dockerfile'] as const) {
      const changed = await createRelease();
      await write(
        changed,
        dockerfile,
        'FROM public.ecr.aws/docker/library/node:24-slim\nENTRYPOINT ["node", "/unexpected.mjs"]\n',
      );
      await expect(
        prepareReleaseEvidence({ outDir: changed, repoRoot }),
        dockerfile,
      ).rejects.toThrow(new RegExp(`${dockerfile} does not match`));
    }

    const missing = await createRelease();
    await rm(path.join(missing, 'catalog-ingestion/Dockerfile'));
    await expect(prepareReleaseEvidence({ outDir: missing, repoRoot })).rejects.toThrow(
      /catalog-ingestion\/Dockerfile/,
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
    expect(deployment.catalogServingCodeKey).toBe(`releases/${version}/catalog-serving.zip`);
    expect(deployment.catalogServingCodeVersion).toBe('object-version-3');
    expect(deployment.userCardsCodeKey).toBe(`releases/${version}/usercards.zip`);
    expect(deployment.userCardsCodeVersion).toBe('object-version-4');
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
    expect(recognition?.browserAssets).toBe(2);

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

  it('refuses a recognition context built from a dirty working tree', async () => {
    const dirty = await createRelease({
      recognition: true,
      recognitionWorkingTree: 'dirty',
    });

    await expect(prepareReleaseEvidence({ outDir: dirty, repoRoot })).rejects.toThrow(
      /dirty working tree/,
    );
  });

  it('verifies the browser assets the recognition manifest records', async () => {
    const omitted = await createRelease({ recognition: true, browserAssets: 'omitted' });
    await expect(prepareReleaseEvidence({ outDir: omitted, repoRoot })).rejects.toThrow(
      /carries no browser asset/,
    );

    const mismatched = await createRelease({ recognition: true, browserAssets: 'mismatched' });
    await expect(prepareReleaseEvidence({ outDir: mismatched, repoRoot })).rejects.toThrow(
      /does not match the identity/,
    );

    const foreignRuntime = await createRelease({
      recognition: true,
      browserAssets: 'foreign-runtime',
    });
    await expect(prepareReleaseEvidence({ outDir: foreignRuntime, repoRoot })).rejects.toThrow(
      /browser runtime/,
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
