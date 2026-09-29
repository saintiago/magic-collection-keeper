/**
 * Integration scope: the packaging step of an explicit deployment
 * (docs/operations.md#packaging-and-deployment, docs/application.md#configuration-and-lifecycle).
 *
 * The command that builds the deployable artifacts runs for real: the same revision is packaged
 * twice and the bytes are compared, the interactive package is loaded the way the API Lambda loads
 * it, the two finite jobs are executed the way their tasks run them and the browser artifact is
 * held to the public settings rule. Publishing, live identity and deployed authorization stay
 * separate evidence (infra/README.md#verification).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigurationError } from '../../src/application/index.js';
import {
  artifactLayout,
  packageArtifacts,
  publicSettingsFromStackOutputs,
  type ArtifactManifest,
} from '../../scripts/package-artifacts.js';
import { readRevision } from '../../scripts/packaging-support.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The public settings a test environment publishes; no private setting belongs beside them. */
const publicSettings = {
  environment: 'test',
  apiBaseUrl: 'https://api.test.keeper.example',
  authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
  recognition: { cloudEnabled: true, computeBaseUrl: 'https://api.test.keeper.example' },
  capabilities: { sourceImports: true },
} as const;

const capturedOutputs = [
  { OutputKey: 'ApiBaseUrl', OutputValue: 'https://api.test.keeper.example' },
  { OutputKey: 'RecognitionBaseUrl', OutputValue: 'https://api.test.keeper.example' },
  { OutputKey: 'UserPoolClientId', OutputValue: 'keeper-test-client' },
  { OutputKey: 'UserPoolId', OutputValue: 'us-east-1_keeper001' },
  { OutputKey: 'BrowserUrl', OutputValue: 'https://keeper.test' },
  { OutputKey: 'DistributionId', OutputValue: 'E1234567890ABC' },
];

describe('packaging the deployable artifacts', () => {
  let workspace: string;
  let outDir: string;
  let manifest: ArtifactManifest;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'keeper-packaging-'));
    outDir = path.join(workspace, 'artifacts');
    ({ manifest } = await packageArtifacts({ outDir, publicSettings }));
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('records the source revision, version and digest of every artifact', async () => {
    expect(manifest.schema).toBe(1);
    expect(manifest.revision).toBe(readRevision(repoRoot));
    expect(manifest.workingTree).toMatch(/^(clean|dirty)$/);
    // The label names artifacts and the published catalog image, so it stays a valid Docker tag.
    expect(manifest.version).toBe(`0.1.0-${manifest.revision.slice(0, 12)}`);
    expect(manifest.version).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
    expect(manifest.artifacts.backend.file).toBe(artifactLayout.backendArchive);
    expect(manifest.artifacts.browser.directory).toBe(artifactLayout.browserDirectory);
    expect(manifest.artifacts.catalog.dockerfile.file).toBe(artifactLayout.catalogDockerfile);
    expect(manifest.artifacts.indexing.file).toBe(artifactLayout.indexingEntry);
    expect(manifest.artifacts.indexing.dockerfile.file).toBe(artifactLayout.indexingDockerfile);
    expect(manifest.artifacts.browser.settings?.file).toBe(artifactLayout.browserSettings);

    const recorded = [
      manifest.artifacts.backend,
      ...manifest.artifacts.browser.files,
      ...(manifest.artifacts.browser.settings === null
        ? []
        : [manifest.artifacts.browser.settings]),
      manifest.artifacts.catalog,
      manifest.artifacts.catalog.dockerfile,
      manifest.artifacts.indexing,
      manifest.artifacts.indexing.dockerfile,
    ];
    expect(recorded.length).toBeGreaterThanOrEqual(5);
    for (const artifact of recorded) {
      const content = await readFile(path.join(outDir, artifact.file));
      expect(content.byteLength).toBe(artifact.bytes);
      expect(createHash('sha256').update(content).digest('hex')).toBe(artifact.sha256);
    }
  });

  it('rebuilds the same artifacts byte for byte', async () => {
    const rebuilt = await packageArtifacts({
      outDir: path.join(workspace, 'rebuild'),
      revision: manifest.revision,
      publicSettings,
    });

    expect(rebuilt.manifest).toEqual(manifest);
    for (const artifact of [
      manifest.artifacts.backend,
      manifest.artifacts.catalog,
      manifest.artifacts.indexing,
    ]) {
      const first = await readFile(path.join(outDir, artifact.file));
      const second = await readFile(path.join(workspace, 'rebuild', artifact.file));
      expect(second.equals(first)).toBe(true);
    }
  }, 120_000);

  it('packages the interactive runtime the API Lambda loads', async () => {
    const archive = await JSZip.loadAsync(
      await readFile(path.join(outDir, artifactLayout.backendArchive)),
    );
    expect(Object.keys(archive.files)).toEqual(['index.mjs']);
    const entry = await archive.file('index.mjs')?.async('nodebuffer');
    expect(entry).toBeDefined();
    const extracted = path.join(workspace, 'backend-index.mjs');
    await writeFile(extracted, entry ?? Buffer.alloc(0));
    const loaded = (await import(pathToFileURL(extracted).href)) as { readonly handler?: unknown };
    expect(typeof loaded.handler).toBe('function');
    // Invoked without this environment's variables, the packaged entry fails closed instead of
    // reaching an unconfigured resource.
    const handler = loaded.handler as (event: unknown) => Promise<{
      readonly statusCode: number;
      readonly body: string;
    }>;
    const response = await handler({
      rawPath: '/api/card',
      requestContext: { http: { method: 'GET', path: '/api/card' } },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('KEEPER_');

    // The package carries every dependency, so the deployed function does not depend on the
    // runtime's own SDK version.
    const source = await readFile(extracted, 'utf8');
    expect(source).not.toContain('from "@aws-sdk/');
    expect(source).not.toContain('from "zod"');

    // The stack's handler names the module and export the loaded package carries.
    const service = JSON.parse(
      await readFile(path.join(repoRoot, 'infra', 'service.json'), 'utf8'),
    ) as {
      readonly Resources: {
        readonly ApiFunction: { readonly Properties: { readonly Handler: string } };
      };
    };
    const [module, exported] = service.Resources.ApiFunction.Properties.Handler.split('.');
    expect(module).toBe(manifest.artifacts.backend.entry.replace(/\.[^.]+$/, ''));
    expect(exported).toBe('handler');
  }, 120_000);

  it('publishes only the public browser settings with the browser artifact', async () => {
    const settings = JSON.parse(
      await readFile(path.join(outDir, artifactLayout.browserSettings), 'utf8'),
    ) as unknown;
    expect(settings).toEqual(publicSettings);
    const page = await readFile(path.join(outDir, artifactLayout.browserPage), 'utf8');
    expect(page).toContain('./app.js');
    const bundle = await readFile(path.join(outDir, artifactLayout.browserEntry), 'utf8');
    // A backend or recognition container dependency must never reach the browser bundle.
    expect(bundle).not.toContain('@aws-sdk/');
    expect(bundle).not.toContain('RDSDataClient');
  });

  it('carries every module the preserved browser recognition engines reach by URL', async () => {
    const directory = path.join(outDir, artifactLayout.browserDirectory);
    const recorded = new Set(
      manifest.artifacts.browser.files.map((file) => path.basename(file.file)),
    );
    // The engines start their workers and load their runtime and catalog by URL, so every
    // relative module a copied browser module reaches has to be beside it.
    expect(recorded.has('visual-worker.js')).toBe(true);
    expect(recorded.has('card-presence-worker.js')).toBe(true);
    for (const name of recorded) {
      if (!name.endsWith('.js') || name === artifactLayout.browserEntry) {
        continue;
      }
      const source = await readFile(path.join(directory, name), 'utf8');
      const reached = new Set([
        ...[...source.matchAll(/from\s*"(\.[^"]+)"/g)].map((match) => match[1] ?? ''),
        ...[...source.matchAll(/import\s*\(\s*"(\.[^"]+)"/g)].map((match) => match[1] ?? ''),
      ]);
      for (const specifier of reached) {
        // The ONNX runtime and model assets under `vendor/` are prepared by the recognition
        // packaging step (docs/operations.md#recognition-packaging), not committed here.
        if (specifier.includes('/vendor/')) {
          continue;
        }
        expect(recorded.has(path.basename(specifier))).toBe(true);
      }
    }
  });

  it('refuses to publish a private setting as a browser setting', async () => {
    await expect(
      packageArtifacts({
        outDir: path.join(workspace, 'private'),
        revision: manifest.revision,
        publicSettings: {
          ...publicSettings,
          resources: { catalogDatabase: { secretArn: 'arn:aws:secretsmanager:…' } },
        },
      }),
    ).rejects.toThrow(ConfigurationError);
  }, 120_000);

  it('packages the catalog job with its digest-pinned image definition', async () => {
    const dockerfile = await readFile(path.join(outDir, artifactLayout.catalogDockerfile), 'utf8');
    expect(dockerfile).toContain('ARG NODE_BASE_IMAGE');
    expect(dockerfile).toContain('FROM ${NODE_BASE_IMAGE}');
    expect(dockerfile).toContain('COPY job.mjs ./job.mjs');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/job/job.mjs"]');
  });

  it('runs the packaged job and reports its outcome without a configuration', async () => {
    const job = path.join(outDir, artifactLayout.catalogEntry);
    const result = await execFileAsync(process.execPath, [job], {
      env: { PATH: process.env['PATH'] ?? '' },
    }).catch((error: unknown) => error as { readonly code?: number; readonly stdout?: string });

    expect((result as { readonly code?: number }).code).toBe(1);
    const record = JSON.parse(
      ((result as { readonly stdout?: string }).stdout ?? '').trim().split('\n').at(-1) ?? '{}',
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      operation: 'catalog.synchronize',
      outcome: 'failed',
      failureCode: 'unavailable',
    });
    expect(String(record['problem'])).toContain('KEEPER_ENVIRONMENT');
  }, 120_000);

  it('packages the background indexing job with its digest-pinned image definition', async () => {
    const dockerfile = await readFile(path.join(outDir, artifactLayout.indexingDockerfile), 'utf8');
    expect(dockerfile).toContain('ARG NODE_BASE_IMAGE');
    expect(dockerfile).toContain('FROM ${NODE_BASE_IMAGE}');
    expect(dockerfile).toContain('COPY job.mjs ./job.mjs');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/job/job.mjs"]');

    // Invoked without this environment's variables, the packaged entry fails closed and reports
    // its own operation instead of reaching an unconfigured resource.
    const job = path.join(outDir, artifactLayout.indexingEntry);
    const result = await execFileAsync(process.execPath, [job], {
      env: { PATH: process.env['PATH'] ?? '' },
    }).catch((error: unknown) => error as { readonly code?: number; readonly stdout?: string });
    expect((result as { readonly code?: number }).code).toBe(1);
    const record = JSON.parse(
      ((result as { readonly stdout?: string }).stdout ?? '').trim().split('\n').at(-1) ?? '{}',
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      operation: 'search.index',
      outcome: 'failed',
      failureCode: 'unavailable',
    });
    expect(String(record['problem'])).toContain('KEEPER_ENVIRONMENT');
  }, 120_000);
});

describe('public settings of a captured deployment', () => {
  it('projects the public outputs of the service stack', () => {
    const previous = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    try {
      expect(publicSettingsFromStackOutputs(capturedOutputs, 'test')).toEqual(publicSettings);
    } finally {
      if (previous === undefined) {
        delete process.env['AWS_REGION'];
      } else {
        process.env['AWS_REGION'] = previous;
      }
    }
  });

  it('rejects captured outputs that name no API entry point', () => {
    expect(() => publicSettingsFromStackOutputs({ UserPoolClientId: 'keeper' }, 'test')).toThrow(
      /ApiBaseUrl/,
    );
  });
});
