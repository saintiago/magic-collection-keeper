/**
 * Packaging of the recognition release (docs/operations.md#recognition-packaging,
 * docs/recognition.md#engines-and-assets).
 *
 * Recognition is one retained engine prepared once and delivered twice: the container image the
 * recognition Lambda runs, and the browser assets the preserved ONNX modules resolve beside
 * themselves. `npm run prepare:recognition` (scripts/prepare-recognition.ts) prepares both halves;
 * this command verifies them through scripts/recognition-manifests.ts and assembles the image build
 * context under `artifacts/recognition/`, recording the engine identities and every context byte
 * beside it. The deployment builds and pushes that context, and the service stack supplies the
 * authenticated API access and the model-provider settings, so nothing environment-specific and no
 * matching threshold changes here.
 */

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  describeFile,
  readPackageVersion,
  readRevision,
  readWorkingTree,
  repoRoot,
  type ArtifactFile,
} from './packaging-support.js';
import {
  engineModules,
  preparedRecognitionRoot,
  verifyPreparedRecognition,
  type RecognitionBrowserIdentity,
  type RecognitionEngineIdentity,
} from './recognition-manifests.js';

/**
 * The digest-pinned AWS Lambda Python runtime the retained engine was verified on. Pinning the
 * base image keeps the built recognition image as reproducible as the context it is built from.
 */
export const recognitionBaseImage =
  'public.ecr.aws/lambda/python:3.12@sha256:2710e8cf77565a70da6f65717645e417074bc15c9e3c2a11f236d5a5398183ba';

/** Paths of the recognition artifact inside the packaging output directory. */
export const recognitionArtifactLayout = {
  directory: 'recognition',
  dockerfile: 'recognition/Dockerfile',
  manifest: 'recognition/manifest.json',
} as const;

/** The prepared assets the image carries inside its `artifacts/` directory. */
const imageArtifactFiles = [
  'artifact-manifest.json',
  'ocr-onnx.json',
  'name-catalog.json',
  'title-names.json.gz',
  'public-card-frame.jpg',
  'public-bolt-frame.jpg',
  'public-ring-frame.jpg',
] as const;

export interface RecognitionArtifactManifest {
  readonly schema: 1;
  /** Source revision the recognition assets were prepared from. */
  readonly revision: string;
  /** Whether that revision was the whole working tree (`clean`) or carried uncommitted changes. */
  readonly workingTree: 'clean' | 'dirty';
  /** Version label a deployment names the recognition image after; a valid Docker/ECR image tag. */
  readonly version: string;
  /** Digest-pinned base image the Dockerfile builds from. */
  readonly baseImage: string;
  readonly engine: RecognitionEngineIdentity;
  readonly browser: RecognitionBrowserIdentity;
  /** Corresponding-source download shipped beside the engine for exactly this revision. */
  readonly source: ArtifactFile;
  /** Every file of the image build context, relative to `artifacts/recognition/`. */
  readonly context: readonly ArtifactFile[];
}

export interface PackageRecognitionOptions {
  /** Directory the recognition artifact is written to; only `recognition/` is replaced. */
  readonly outDir: string;
  /** Checkout the prepared engine is packaged from; defaults to the running repository. */
  readonly repoRoot?: string;
  /** Source revision of the artifacts; defaults to the checked-out commit. */
  readonly revision?: string;
}

export interface PackagedRecognition {
  readonly manifest: RecognitionArtifactManifest;
  readonly manifestPath: string;
  readonly contextDirectory: string;
}

/**
 * Verifies every pinned manifest and hash of the prepared engine and assembles the image build
 * context for `outDir`, recording what it packaged beside the context.
 */
export async function packageRecognition(
  options: PackageRecognitionOptions,
): Promise<PackagedRecognition> {
  const root = options?.repoRoot ?? repoRoot;
  const outDir = path.resolve(root, readOutDir(options));
  const revision = options?.revision ?? readRevision(root);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(
      'Packaging the recognition image context requires the 40-character source revision it belongs to.',
    );
  }
  const verified = await verifyPreparedRecognition(root);
  const contextDirectory = path.join(outDir, recognitionArtifactLayout.directory);
  await rm(contextDirectory, { recursive: true, force: true });
  await mkdir(contextDirectory, { recursive: true });
  await assembleContext(root, contextDirectory);
  const manifest: RecognitionArtifactManifest = {
    schema: 1,
    revision,
    workingTree: readWorkingTree(root),
    version: `${readPackageVersion(root)}-${revision.slice(0, 12)}`,
    baseImage: recognitionBaseImage,
    engine: verified.engine,
    browser: verified.browser,
    source: verified.source,
    context: await describeContext(contextDirectory),
  };
  const manifestPath = path.join(outDir, recognitionArtifactLayout.manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, contextDirectory };
}

/** The assembled image build context as the deployment builds and pushes it. */
async function assembleContext(root: string, contextDirectory: string): Promise<void> {
  const pythonRoot = preparedRecognitionRoot(root);
  const preparedRoot = path.join(pythonRoot, 'artifacts');
  for (const module of await engineModules(pythonRoot)) {
    const target = module === 'scripts/smoke.py' ? 'smoke.py' : module;
    await cp(path.join(pythonRoot, module), path.join(contextDirectory, target));
  }
  await copyTree(path.join(pythonRoot, 'adapters'), path.join(contextDirectory, 'adapters'));
  await copyTree(path.join(pythonRoot, 'notices'), path.join(contextDirectory, 'notices'));
  await mkdir(path.join(contextDirectory, 'artifacts'), { recursive: true });
  for (const name of imageArtifactFiles) {
    await cp(path.join(preparedRoot, name), path.join(contextDirectory, 'artifacts', name));
  }
  for (const name of ['weights', 'catalog', 'ocr-onnx']) {
    await copyTree(path.join(preparedRoot, name), path.join(contextDirectory, 'artifacts', name));
  }
  await copyTree(
    path.join(pythonRoot, 'vendor', 'CollectorVision'),
    path.join(contextDirectory, 'vendor', 'CollectorVision'),
  );
  for (const name of ['LICENSE', 'source.zip', 'requirements-linux.txt']) {
    await cp(path.join(pythonRoot, name), path.join(contextDirectory, name));
  }
  await writeFile(path.join(contextDirectory, 'Dockerfile'), recognitionDockerfile(), 'utf8');
}

/**
 * The recognition container of docs/operations.md#recognition-packaging: the digest-pinned Lambda
 * Python runtime, the retained engine, the verified assets, the notices and the
 * corresponding-source download. Model-provider settings stay with the deployed function.
 */
function recognitionDockerfile(): string {
  return [
    '# Container image of the retained recognition engine (docs/operations.md#recognition-packaging).',
    '# Build from this directory and push the resulting image to the exported recognition repository:',
    '#   docker build -t <repository>:<manifest version> artifacts/recognition',
    `FROM ${recognitionBaseImage}`,
    'WORKDIR /var/task',
    '# System libraries the retained OpenCV and ONNX Runtime engines load.',
    'RUN dnf install -y mesa-libGL glib2 libgomp && dnf clean all',
    'COPY requirements-linux.txt /tmp/requirements-linux.txt',
    'RUN pip install --no-cache-dir -r /tmp/requirements-linux.txt',
    '# The pinned upstream CollectorVision package, installed without fetching anything else.',
    'COPY vendor/CollectorVision /tmp/collectorvision',
    'RUN pip install --no-cache-dir --no-deps /tmp/collectorvision && pip check',
    'COPY *.py ./',
    'COPY adapters ./adapters',
    'COPY artifacts ./artifacts',
    'COPY notices ./notices',
    'COPY LICENSE source.zip ./',
    'COPY smoke.py ./smoke.py',
    '# Retained engine settings only; the model-provider settings and credentials come from the',
    '# deployed function (infra/README.md#runtime-environment).',
    'ENV RECOGNITION_ARTIFACTS=/var/task/artifacts \\',
    '    KEEPER_OCR_ADAPTER=paddle-onnx \\',
    '    ORT_DISABLE_TELEMETRY=1 \\',
    '    XDG_CACHE_HOME=/tmp/cache \\',
    '    HF_HUB_OFFLINE=1 \\',
    '    OMP_NUM_THREADS=2 \\',
    '    OPENBLAS_NUM_THREADS=2 \\',
    '    MKL_NUM_THREADS=2',
    'ENTRYPOINT ["/lambda-entrypoint.sh"]',
    'CMD ["lambda_entry.handler"]',
    '',
  ].join('\n');
}

/** Every file of the assembled context, relative to the directory the deployment builds from. */
async function describeContext(contextDirectory: string): Promise<readonly ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(contextDirectory, relative), { withFileTypes: true });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      files.push(await describeFile(contextDirectory, next));
    }
  }
  await walk('');
  return files;
}

/** One recursive copy of prepared content; git metadata and caches never enter the context. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!includePrepared(entry.name)) {
      continue;
    }
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target);
      continue;
    }
    await cp(source, target);
  }
}

const excludedNames = new Set(['.git', '__pycache__', '.pytest_cache']);

function includePrepared(name: string): boolean {
  return !excludedNames.has(name) && !name.endsWith('.egg-info') && !name.endsWith('.pyc');
}

interface CommandLine {
  readonly outDir: string;
}

function readCommandLine(argv: readonly string[]): CommandLine {
  let outDir = 'artifacts';
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== '--out') {
      throw new Error(`Unsupported packaging flag ${flag ?? ''}.`);
    }
    if (value === undefined) {
      throw new Error('The --out flag requires a value.');
    }
    outDir = value;
    index += 1;
  }
  return { outDir };
}

function readOutDir(options: PackageRecognitionOptions): string {
  if (typeof options?.outDir !== 'string' || options.outDir.length === 0) {
    throw new Error('Packaging the recognition image context requires its output directory.');
  }
  return options.outDir;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = readCommandLine(process.argv.slice(2));
  const packaged = await packageRecognition({ outDir: command.outDir });
  const destination = path.relative(repoRoot, packaged.manifestPath) || packaged.manifestPath;
  console.log(
    `Packaged the recognition image context (${packaged.manifest.context.length} files) and the ` +
      `corresponding-source download for revision ${packaged.manifest.revision.slice(0, 12)} ` +
      `into ${destination}.`,
  );
}
