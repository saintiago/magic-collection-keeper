/**
 * Packaging of the deployable artifacts (docs/operations.md#packaging-and-deployment).
 *
 * One command builds the artifacts an explicit deployment needs from the committed sources and the
 * locked dependencies: the interactive backend package (one zip the API Lambda runs), the
 * browser bundle (the static files CloudFront delivers) and the two finite background jobs — the
 * catalog job and the Search indexing job — as one module and the Dockerfile that packages each.
 * Nothing environment-specific is baked into a build: the public browser settings of one
 * environment are written as `browser/config.json` when the deployment supplies the stack's
 * captured outputs, and no secret, resource ARN or credential reference ever reaches the browser
 * artifact.
 *
 * Every artifact is content-addressed in `manifest.json` beside the source revision, the locked
 * dependency state and the Node.js version it was built with, so a released combination can be
 * inspected and the exact artifact of one revision restored. Packaging is deterministic: the same
 * revision and lockfile produce the same bytes, which `tests/integration/packaging.test.ts`
 * verifies by rebuilding.
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import JSZip from 'jszip';

import { resolvePublicSettings, type PublicApplicationSettings } from '../src/application/index.js';
import {
  artifactLayout,
  describeFile,
  readPackageVersion,
  readRevision,
  readWorkingTree,
  repoRoot,
  type ArtifactFile,
} from './packaging-support.js';

export { artifactLayout };

/** Fixed timestamp of every archive entry, so a rebuilt package keeps the same bytes. */
const archiveDate = new Date('2000-01-01T00:00:00.000Z');

/** Node.js runtime the packaged artifacts run on (docs/tech-stack.md#platform). */
const nodeTarget = 'node24';

/** Region of the deployed stack (docs/tech-stack.md#aws-stack). */
const defaultRegion = 'us-east-1';

export interface ArtifactManifest {
  readonly schema: 1;
  /** Source revision the artifacts were built from. */
  readonly revision: string;
  /** Whether that revision was the whole working tree (`clean`) or carried uncommitted changes. */
  readonly workingTree: 'clean' | 'dirty';
  /** Version label a deployment names its artifacts after; a valid Docker/ECR image tag. */
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly artifacts: {
    readonly backend: ArtifactFile & { readonly entry: string };
    readonly browser: {
      readonly directory: string;
      readonly files: readonly ArtifactFile[];
      readonly settings: ArtifactFile | null;
    };
    /**
     * The job module and the container definition that packages it. Both are release bytes: the
     * deployment builds the image from this Dockerfile, so the evidence has to verify it too
     * (docs/release-checklist.md#source-completion).
     */
    readonly catalog: ArtifactFile & { readonly dockerfile: ArtifactFile };
    readonly indexing: ArtifactFile & { readonly dockerfile: ArtifactFile };
  };
}

export interface PackageArtifactsOptions {
  /**
   * Directory the artifacts are written to. Every artifact this command owns is replaced, never
   * merged; another packaging command's artifact beside them, such as the recognition image
   * context, is left alone.
   */
  readonly outDir: string;
  /** Source revision of the artifacts; defaults to the checked-out commit. */
  readonly revision?: string;
  /** Raw public settings to publish with the browser bundle. */
  readonly publicSettings?: unknown;
  readonly repoRoot?: string;
}

export interface PackagedArtifacts {
  readonly manifest: ArtifactManifest;
  readonly manifestPath: string;
}

/** Builds every artifact of this revision into `outDir` and records its manifest. */
export async function packageArtifacts(
  options: PackageArtifactsOptions,
): Promise<PackagedArtifacts> {
  const root = options?.repoRoot ?? repoRoot;
  const outDir = path.resolve(root, readOutDir(options));
  const revision = options?.revision ?? readRevision(root);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('Packaging requires the 40-character source revision the artifacts belong to.');
  }
  const publicSettings =
    options?.publicSettings === undefined ? null : resolvePublicSettings(options.publicSettings);
  // Only the artifacts of this command are replaced: the recognition packaging command writes its
  // image context into the same directory (docs/operations.md#recognition-packaging).
  const ownedPaths = [
    ...new Set(
      [
        artifactLayout.backendArchive,
        artifactLayout.browserDirectory,
        artifactLayout.catalogEntry,
        artifactLayout.indexingEntry,
        artifactLayout.manifest,
      ].map((file) => file.split('/')[0] ?? file),
    ),
  ];
  for (const owned of ownedPaths) {
    await rm(path.join(outDir, owned), { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  await buildBackend(root, outDir);
  await buildBrowser(root, outDir, publicSettings);
  await buildCatalog(root, outDir);
  await buildIndexing(root, outDir);

  const manifest: ArtifactManifest = {
    schema: 1,
    revision,
    workingTree: readWorkingTree(root),
    // A Docker tag accepts word characters, periods and hyphens, so the release label joins the
    // package version and the short revision with a hyphen and names both background-job images.
    version: `${readPackageVersion(root)}-${revision.slice(0, 12)}`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    artifacts: {
      backend: {
        ...(await describeFile(outDir, artifactLayout.backendArchive)),
        entry: 'index.mjs',
      },
      browser: {
        directory: artifactLayout.browserDirectory,
        files: await describeDirectory(outDir, artifactLayout.browserDirectory),
        settings:
          publicSettings === null
            ? null
            : await describeFile(outDir, artifactLayout.browserSettings),
      },
      catalog: {
        ...(await describeFile(outDir, artifactLayout.catalogEntry)),
        dockerfile: await describeFile(outDir, artifactLayout.catalogDockerfile),
      },
      indexing: {
        ...(await describeFile(outDir, artifactLayout.indexingEntry)),
        dockerfile: await describeFile(outDir, artifactLayout.indexingDockerfile),
      },
    },
  };
  const manifestPath = path.join(outDir, artifactLayout.manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath };
}

async function buildBackend(root: string, outDir: string): Promise<void> {
  const entry = path.join(outDir, artifactLayout.backendEntry);
  await bundle(root, path.join(root, 'src', 'application', 'lambda.ts'), entry, 'node');
  const source = await readFile(entry);
  const archive = await zipArchive({ 'index.mjs': source });
  await writeFile(path.join(outDir, artifactLayout.backendArchive), archive);
}

async function buildBrowser(
  root: string,
  outDir: string,
  publicSettings: PublicApplicationSettings | null,
): Promise<void> {
  const entry = path.join(root, 'src', 'ui', 'deployment.ts');
  const specifier = `./${path.relative(root, entry).split(path.sep).join('/')}`;
  const boot = [
    `import { createBrowserDeployment } from ${JSON.stringify(specifier)};`,
    "const settings = await fetch(new URL('./config.json', import.meta.url), {",
    "  cache: 'no-store',",
    '}).then((response) => response.json());',
    "const root = document.getElementById('keeper-root');",
    'globalThis.keeperDeployment = createBrowserDeployment({ root, settings });',
  ].join('\n');
  await bundleBoot(root, boot, path.join(outDir, artifactLayout.browserEntry), 'browser');
  await writeFile(path.join(outDir, artifactLayout.browserPage), browserPage(), 'utf8');
  // The preserved browser recognition modules stay loadable as modules: the workers the engines
  // start, and the ONNX runtime and catalog they resolve next to themselves, are reached by URL
  // rather than through the bundle (src/recognition/README.md). The prepared runtime assets belong
  // to the recognition packaging task; a delivery build copies whatever is prepared.
  const browserModules = path.join(root, 'src', 'recognition', 'browser');
  for (const name of (await readdir(browserModules)).sort()) {
    if (name.endsWith('.js')) {
      await cp(
        path.join(browserModules, name),
        path.join(outDir, artifactLayout.browserDirectory, name),
      );
    }
  }
  const vendor = path.join(browserModules, 'vendor');
  if (existsSync(vendor)) {
    await cp(vendor, path.join(outDir, artifactLayout.browserDirectory, 'vendor'), {
      recursive: true,
    });
  }
  if (publicSettings !== null) {
    await writeFile(
      path.join(outDir, artifactLayout.browserSettings),
      `${JSON.stringify(publicSettings, null, 2)}\n`,
      'utf8',
    );
  }
}

async function buildCatalog(root: string, outDir: string): Promise<void> {
  await bundle(
    root,
    path.join(root, 'src', 'application', 'catalog-job.ts'),
    path.join(outDir, artifactLayout.catalogEntry),
    'node',
  );
  await writeFile(path.join(outDir, artifactLayout.catalogDockerfile), catalogDockerfile(), 'utf8');
}

/**
 * The background indexing job: one bundled module composing Search's indexer over the Search
 * indexing credential, packaged exactly like the catalog job.
 */
async function buildIndexing(root: string, outDir: string): Promise<void> {
  await bundle(
    root,
    path.join(root, 'src', 'application', 'indexing-job.ts'),
    path.join(outDir, artifactLayout.indexingEntry),
    'node',
  );
  await writeFile(
    path.join(outDir, artifactLayout.indexingDockerfile),
    indexingDockerfile(),
    'utf8',
  );
}

/**
 * One bundle of a committed entry and every dependency it reaches, so the artifact does not depend
 * on a runtime's own version of a dependency. The Lambda and container runtimes only supply
 * Node.js.
 */
async function bundle(
  root: string,
  entry: string,
  outfile: string,
  platform: 'node' | 'browser',
): Promise<void> {
  await build(bundleOptions(root, outfile, platform, { entryPoints: [entry] }));
}

/** One bundle of the browser boot code the page loads; the same options, from generated source. */
async function bundleBoot(
  root: string,
  contents: string,
  outfile: string,
  platform: 'node' | 'browser',
): Promise<void> {
  await build(
    bundleOptions(root, outfile, platform, {
      stdin: { contents, resolveDir: root, sourcefile: 'browser-entry.ts', loader: 'ts' },
    }),
  );
}

function bundleOptions(
  root: string,
  outfile: string,
  platform: 'node' | 'browser',
  entry:
    | { readonly entryPoints: string[] }
    | { readonly stdin: NonNullable<Parameters<typeof build>[0]['stdin']> },
): Parameters<typeof build>[0] {
  return {
    ...entry,
    bundle: true,
    format: 'esm',
    platform,
    target: platform === 'node' ? nodeTarget : 'es2022',
    // The AWS SDK publishes both builds; the ESM one keeps the bundle free of CommonJS
    // `require` shims the Node.js runtimes cannot evaluate.
    mainFields: platform === 'node' ? ['module', 'main'] : ['browser', 'module', 'main'],
    outfile,
    legalComments: 'none',
    logLevel: 'silent',
    absWorkingDir: root,
  };
}

/** One deterministic zip archive; every entry carries the same fixed timestamp. */
async function zipArchive(files: Readonly<Record<string, Uint8Array>>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { date: archiveDate, unixPermissions: 0o644, createFolders: false });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
    mimeType: 'application/zip',
  });
}

function browserPage(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Magic Collection Keeper</title>',
    '  </head>',
    '  <body>',
    '    <div id="keeper-root"></div>',
    '    <script type="module" src="./app.js"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The catalog image packages the built module only; the deployment pins the Node.js base image by
 * digest so the built image is as reproducible as the module it carries.
 */
function catalogDockerfile(): string {
  return [
    '# Finite catalog job image (docs/operations.md#packaging-and-deployment).',
    '# The deployment passes the digest-pinned base image it verified, for example:',
    '#   docker build --build-arg NODE_BASE_IMAGE=node@sha256:<digest> -t <catalog-repo>:<version> .',
    'ARG NODE_BASE_IMAGE',
    'FROM ${NODE_BASE_IMAGE}',
    'WORKDIR /job',
    'COPY job.mjs ./job.mjs',
    'ENTRYPOINT ["node", "/job/job.mjs"]',
    '',
  ].join('\n');
}

/**
 * The indexing image packages the built module only; like the catalog job, the deployment pins the
 * Node.js base image by digest so the built image is as reproducible as the module it carries.
 */
function indexingDockerfile(): string {
  return [
    '# Background indexing job image (docs/operations.md#packaging-and-deployment).',
    '# The deployment passes the digest-pinned base image it verified, for example:',
    '#   docker build --build-arg NODE_BASE_IMAGE=node@sha256:<digest> -t <indexing-repo>:<version> .',
    'ARG NODE_BASE_IMAGE',
    'FROM ${NODE_BASE_IMAGE}',
    'WORKDIR /job',
    'COPY job.mjs ./job.mjs',
    'ENTRYPOINT ["node", "/job/job.mjs"]',
    '',
  ].join('\n');
}

async function describeDirectory(
  outDir: string,
  directory: string,
): Promise<readonly ArtifactFile[]> {
  const base = path.join(outDir, directory);
  const files: ArtifactFile[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      files.push(await describeFile(outDir, path.relative(outDir, target)));
    }
  }
  await walk(base);
  return files;
}

function readOutDir(options: PackageArtifactsOptions): string {
  if (typeof options?.outDir !== 'string' || options.outDir.length === 0) {
    throw new Error('Packaging requires the directory the artifacts are written to.');
  }
  return options.outDir;
}

/**
 * Projects the captured service-stack outputs onto the public browser settings
 * (infra/service.json#Outputs). Only outputs that are public settings are read; a stack output
 * that is not a setting is ignored instead of published.
 */
export function publicSettingsFromStackOutputs(
  outputs: unknown,
  environment: string,
  region: string = defaultRegion,
): PublicApplicationSettings {
  const captured = readStackOutputs(outputs);
  const apiBaseUrl = captured['ApiBaseUrl'];
  const computeBaseUrl = captured['RecognitionBaseUrl'] ?? apiBaseUrl;
  if (apiBaseUrl === undefined) {
    throw new Error('The captured service-stack outputs name no ApiBaseUrl.');
  }
  return resolvePublicSettings({
    environment,
    apiBaseUrl,
    authentication: {
      region,
      appClientId: captured['UserPoolClientId'],
    },
    recognition: {
      cloudEnabled: computeBaseUrl !== undefined,
      computeBaseUrl: computeBaseUrl ?? null,
    },
    capabilities: { sourceImports: true },
  });
}

function readStackOutputs(outputs: unknown): Readonly<Record<string, string>> {
  const entries = Array.isArray(outputs)
    ? outputs.map((entry) => {
        const record = readRecord(entry);
        return [record?.['OutputKey'], record?.['OutputValue']] as const;
      })
    : Object.entries(readRecord(outputs) ?? {});
  const captured: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof key === 'string' && typeof value === 'string') {
      captured[key] = value;
    }
  }
  return captured;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

interface CommandLine {
  readonly outDir: string;
  readonly publicSettings: string | null;
  readonly stackOutputs: string | null;
  readonly environment: string | null;
}

function readCommandLine(argv: readonly string[]): CommandLine {
  const command: {
    outDir?: string;
    publicSettings?: string;
    stackOutputs?: string;
    environment?: string;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`The ${flag ?? 'package'} flag requires a value.`);
    }
    switch (flag) {
      case '--out':
        command.outDir = value;
        break;
      case '--public-settings':
        command.publicSettings = value;
        break;
      case '--from-outputs':
        command.stackOutputs = value;
        break;
      case '--environment':
        command.environment = value;
        break;
      default:
        throw new Error(`Unsupported packaging flag ${flag ?? ''}.`);
    }
    index += 1;
  }
  return {
    outDir: command.outDir ?? 'artifacts',
    publicSettings: command.publicSettings ?? null,
    stackOutputs: command.stackOutputs ?? null,
    environment: command.environment ?? null,
  };
}

async function readPublicSettings(command: CommandLine): Promise<unknown | undefined> {
  if (command.publicSettings === null && command.stackOutputs === null) {
    return undefined;
  }
  if (command.publicSettings !== null && command.stackOutputs !== null) {
    throw new Error('Name either --public-settings or --from-outputs, not both.');
  }
  if (command.publicSettings !== null) {
    return JSON.parse(await readFile(command.publicSettings, 'utf8'));
  }
  if (command.environment === null) {
    throw new Error('Projecting the captured stack outputs requires --environment.');
  }
  const outputs = JSON.parse(await readFile(command.stackOutputs ?? '', 'utf8'));
  return publicSettingsFromStackOutputs(
    outputs,
    command.environment,
    process.env['AWS_REGION'] ?? defaultRegion,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = readCommandLine(process.argv.slice(2));
  const packaged = await packageArtifacts({
    outDir: command.outDir,
    publicSettings: await readPublicSettings(command),
  });
  const destination = path.relative(repoRoot, packaged.manifestPath) || packaged.manifestPath;
  console.log(
    `Packaged ${packaged.manifest.artifacts.backend.file}, ` +
      `${packaged.manifest.artifacts.browser.directory}/ and ` +
      `${packaged.manifest.artifacts.catalog.file} and ` +
      `${packaged.manifest.artifacts.indexing.file} for revision ` +
      `${packaged.manifest.revision.slice(0, 12)} into ${destination}.`,
  );
}
