/**
 * Release acceptance evidence (docs/operations.md#release-acceptance, docs/release-checklist.md).
 *
 * One command prepares the acceptance record of one packaged release beside its manifest. It
 * re-verifies every byte the packaging manifest names, requires the packaging and recognition
 * manifests to come from a clean committed revision, ties the optional recognition manifest and the
 * deployment's release record to the same release, and keeps source completion, deployment and
 * production acceptance separate. The provider, physical-device and collection-reconciliation
 * checks the rebuild cannot establish stay recorded as unresolved. Nothing here deploys, migrates
 * or reads owner data.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The manifest interfaces are the packaging commands' published shapes; a type-only import keeps
// this command from evaluating the packaging modules it only describes.
import type { ArtifactManifest } from './package-artifacts.js';
import type { RecognitionArtifactManifest } from './package-recognition.js';
import {
  artifactLayout,
  readRevision,
  recognitionArtifactLayout,
  repoRoot,
  type ArtifactFile,
} from './packaging-support.js';

/** Paths of the release acceptance record inside the packaging output directory. */
export const releaseEvidenceLayout = {
  releaseRecord: 'release.json',
  evidence: 'release-evidence.json',
} as const;

/** One artifact byte range the acceptance record refers to; `file` is relative to the release. */
export interface ReleaseEvidenceFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The recognition identities of a release whose image context was packaged. */
export interface RecognitionEvidence {
  readonly manifest: ReleaseEvidenceFile;
  readonly version: string;
  readonly baseImage: string;
  /** Corresponding-source download of exactly this revision, as the context carries it. */
  readonly source: ReleaseEvidenceFile;
  readonly contextFiles: number;
  /** Browser recognition assets the packaged browser manifest carries, byte for byte. */
  readonly browserAssets: number;
}

export interface SourceCompletionStage {
  readonly status: 'recorded' | 'not-recorded';
  readonly manifest: ReleaseEvidenceFile;
  readonly verifiedFiles: number;
  /** Present when `npm run package:recognition` packaged the image context beside the release. */
  readonly recognition: RecognitionEvidence | null;
}

export interface DeploymentStage {
  readonly status: 'recorded' | 'not-recorded';
  /** Why a stage is not recorded yet; recorded stages carry no reason. */
  readonly reason: string | null;
  readonly release: ReleaseEvidenceFile | null;
  readonly environment: string | null;
  readonly apiCodeKey: string | null;
  readonly apiCodeVersion: string | null;
  readonly recognitionImageUri: string | null;
  readonly catalogJobImageUri: string | null;
}

export interface ProductionAcceptanceStage {
  readonly status: 'recorded' | 'not-recorded';
  readonly reason: string;
}

/** A check the rebuild cannot establish, kept explicit instead of implied by silence. */
export interface UnresolvedCheck {
  readonly id: string;
  readonly section: string;
  readonly status: 'unresolved';
}

/**
 * Checks the rebuild records as unresolved (docs/operations.md#release-acceptance). Live
 * provider and physical-device evidence needs a deployed environment and real hardware, and
 * collection reconciliation is deferred with the migration (docs/requirements.md#collection-migration).
 */
export const unresolvedChecks: readonly UnresolvedCheck[] = [
  {
    id: 'provider-model-calls',
    section: 'docs/operations.md#recognition-packaging',
    status: 'unresolved',
  },
  {
    id: 'physical-device-acceptance',
    section: 'docs/operations.md#recognition-packaging',
    status: 'unresolved',
  },
  {
    id: 'collection-reconciliation',
    section: 'docs/requirements.md#collection-migration',
    status: 'unresolved',
  },
];

export interface ReleaseEvidence {
  readonly schema: 1;
  readonly checklist: 'docs/release-checklist.md';
  readonly revision: string;
  readonly version: string;
  readonly workingTree: 'clean' | 'dirty';
  readonly stages: {
    readonly sourceCompletion: SourceCompletionStage;
    readonly deployment: DeploymentStage;
    readonly productionAcceptance: ProductionAcceptanceStage;
  };
  readonly unresolvedChecks: readonly UnresolvedCheck[];
}

export interface PrepareReleaseEvidenceOptions {
  /** Release directory `npm run package` wrote, holding `manifest.json` and its artifacts. */
  readonly outDir: string;
  /** Checkout the release belongs to; defaults to the running repository. */
  readonly repoRoot?: string;
}

export interface PreparedReleaseEvidence {
  readonly evidence: ReleaseEvidence;
  readonly evidencePath: string;
}

/**
 * Verifies one release directory and records its acceptance evidence. Recorded bytes are checked
 * against the packaging manifest, so the record names exactly the artifacts it inspected.
 */
export async function prepareReleaseEvidence(
  options: PrepareReleaseEvidenceOptions,
): Promise<PreparedReleaseEvidence> {
  const root = options?.repoRoot ?? repoRoot;
  const outDir = path.resolve(root, readOutDir(options));
  const manifest = readArtifactManifest(await readJsonFile(outDir, artifactLayout.manifest));
  if (manifest.workingTree !== 'clean') {
    throw new Error(
      `${artifactLayout.manifest} records a dirty working tree; a release needs the committed ` +
        'revision it was built from (docs/operations.md#packaging-and-deployment).',
    );
  }
  const revision = readRevision(root);
  if (manifest.revision !== revision) {
    throw new Error(
      `${artifactLayout.manifest} belongs to revision ${manifest.revision} instead of the ` +
        `checkout's ${revision}; prepare the release from its own checkout.`,
    );
  }

  const verifiedFiles = await verifyManifestArtifacts(outDir, manifest);
  const recognition = await readRecognitionEvidence(outDir, manifest);
  const deployment = await readDeploymentEvidence(outDir, manifest);
  const evidence: ReleaseEvidence = {
    schema: 1,
    checklist: 'docs/release-checklist.md',
    revision: manifest.revision,
    version: manifest.version,
    workingTree: manifest.workingTree,
    stages: {
      sourceCompletion: {
        status: 'recorded',
        manifest: await readRecordedFile(outDir, artifactLayout.manifest),
        verifiedFiles,
        recognition,
      },
      deployment,
      productionAcceptance: {
        status: 'not-recorded',
        reason:
          'Production acceptance is recorded after an authorized cutover. Collection migration ' +
          'remains deferred with it (docs/requirements.md#collection-migration).',
      },
    },
    unresolvedChecks,
  };
  const evidencePath = path.join(outDir, releaseEvidenceLayout.evidence);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { evidence, evidencePath };
}

/** Verifies every recorded byte range of the release and reports how many files were checked. */
async function verifyManifestArtifacts(
  outDir: string,
  manifest: ArtifactManifest,
): Promise<number> {
  const recorded: readonly ArtifactFile[] = [
    manifest.artifacts.backend,
    ...manifest.artifacts.browser.files,
    ...(manifest.artifacts.browser.settings === null ? [] : [manifest.artifacts.browser.settings]),
    manifest.artifacts.catalog,
    manifest.artifacts.catalog.dockerfile,
  ];
  for (const file of recorded) {
    await verifyRecordedFile(outDir, file);
  }
  return recorded.length;
}

/**
 * The recognition half of a release, when its image context was packaged
 * (docs/operations.md#recognition-packaging). The context is verified file by file, and it has to
 * carry the corresponding-source download the recognition manifest records.
 */
async function readRecognitionEvidence(
  outDir: string,
  manifest: ArtifactManifest,
): Promise<RecognitionEvidence | null> {
  if (!existsSync(path.join(outDir, recognitionArtifactLayout.manifest))) {
    return null;
  }
  const recognition = readRecognitionManifest(
    await readJsonFile(outDir, recognitionArtifactLayout.manifest),
  );
  if (recognition.workingTree !== 'clean') {
    throw new Error(
      `${recognitionArtifactLayout.manifest} records a dirty working tree; a release needs the ` +
        'committed revision it was built from (docs/operations.md#packaging-and-deployment).',
    );
  }
  if (recognition.revision !== manifest.revision || recognition.version !== manifest.version) {
    throw new Error(
      `${recognitionArtifactLayout.manifest} belongs to another release than ` +
        `${artifactLayout.manifest}.`,
    );
  }
  const browserAssets = verifyRecognitionBrowserAssets(manifest, recognition.browser);
  const contextDirectory = path.join(outDir, recognitionArtifactLayout.directory);
  for (const file of recognition.context) {
    await verifyRecordedFile(contextDirectory, file);
  }
  const source = recognition.context.find(
    (file) => file.sha256 === recognition.source.sha256 && file.bytes === recognition.source.bytes,
  );
  if (source === undefined) {
    throw new Error(
      `${recognitionArtifactLayout.manifest} records a corresponding-source download the image ` +
        'context does not carry.',
    );
  }
  return {
    manifest: await readRecordedFile(outDir, recognitionArtifactLayout.manifest),
    version: recognition.version,
    baseImage: recognition.baseImage,
    source: { ...source, file: `${recognitionArtifactLayout.directory}/${source.file}` },
    contextFiles: recognition.context.length,
    browserAssets,
  };
}

/**
 * The browser half of the recognition release: `npm run package` copies the prepared browser assets
 * into the packaged `browser/` directory and records their bytes, and the recognition manifest
 * publishes the same identities. A context prepared after the browser was packaged would otherwise
 * be certified with assets the release does not carry, so every asset has to be the one the
 * packaging manifest already verified.
 */
function verifyRecognitionBrowserAssets(
  manifest: ArtifactManifest,
  browser: RecognitionArtifactManifest['browser'],
): number {
  const packaged = new Map(manifest.artifacts.browser.files.map((file) => [file.file, file]));
  const runtimeFile = `browser/vendor/ort/${browser.runtime.file}`;
  const carriesRuntime = browser.assets.some(
    (asset) =>
      asset.file === runtimeFile &&
      asset.bytes === browser.runtime.bytes &&
      asset.sha256 === browser.runtime.sha256,
  );
  if (!carriesRuntime) {
    throw new Error(
      `${recognitionArtifactLayout.manifest} records a browser runtime its assets do not carry.`,
    );
  }
  for (const asset of browser.assets) {
    const carried = packaged.get(asset.file);
    if (carried === undefined) {
      throw new Error(
        `The packaged ${artifactLayout.manifest} carries no browser asset ${asset.file} the ` +
          `${recognitionArtifactLayout.manifest} records; package the browser from the prepared ` +
          'recognition assets.',
      );
    }
    if (carried.bytes !== asset.bytes || carried.sha256 !== asset.sha256) {
      throw new Error(
        `The packaged browser asset ${asset.file} does not match the identity the ` +
          `${recognitionArtifactLayout.manifest} records.`,
      );
    }
  }
  return browser.assets.length;
}

/**
 * The deployment stage, recorded only from the release record a deployment captures beside the
 * manifest (infra/README.md#create). The record has to name this release, so an inspected
 * deployment can be restored from the release it actually ran.
 */
async function readDeploymentEvidence(
  outDir: string,
  manifest: ArtifactManifest,
): Promise<DeploymentStage> {
  if (!existsSync(path.join(outDir, releaseEvidenceLayout.releaseRecord))) {
    return {
      status: 'not-recorded',
      reason:
        'No release record beside the release: no deployment has been executed for it. ' +
        'Deployment execution requires explicit authorization (docs/operations.md#release-acceptance).',
      release: null,
      environment: null,
      apiCodeKey: null,
      apiCodeVersion: null,
      recognitionImageUri: null,
      catalogJobImageUri: null,
    };
  }
  const file = await readRecordedFile(outDir, releaseEvidenceLayout.releaseRecord);
  const parameters = readStackParameters(
    await readJsonFile(outDir, releaseEvidenceLayout.releaseRecord),
  );
  const required = [
    'Environment',
    'ApiCodeKey',
    'ApiCodeVersion',
    'RecognitionImageUri',
    'CatalogJobImageUri',
  ] as const;
  for (const name of required) {
    if ((parameters[name] ?? '').length === 0) {
      throw new Error(
        `${releaseEvidenceLayout.releaseRecord} names no ${name}; capture the service stack's ` +
          'parameters after a deployment (infra/README.md#create).',
      );
    }
  }
  const apiCodeKey = parameters['ApiCodeKey'] as string;
  const expectedKey = `releases/${manifest.version}/api.zip`;
  if (apiCodeKey !== expectedKey) {
    throw new Error(
      `${releaseEvidenceLayout.releaseRecord}'s ApiCodeKey ${apiCodeKey} does not name this ` +
        `release; the interactive package is published as ${expectedKey} ` +
        '(infra/README.md#packaging-and-publication).',
    );
  }
  for (const name of ['RecognitionImageUri', 'CatalogJobImageUri'] as const) {
    const uri = parameters[name] as string;
    if (!/@sha256:[0-9a-f]{64}$/.test(uri)) {
      throw new Error(
        `${releaseEvidenceLayout.releaseRecord}'s ${name} is not pinned by digest (${uri}); ` +
          'artifacts are restored by their immutable identity.',
      );
    }
  }
  return {
    status: 'recorded',
    reason: null,
    release: file,
    environment: parameters['Environment'] as string,
    apiCodeKey,
    apiCodeVersion: parameters['ApiCodeVersion'] as string,
    recognitionImageUri: parameters['RecognitionImageUri'] as string,
    catalogJobImageUri: parameters['CatalogJobImageUri'] as string,
  };
}

/** The captured service-stack parameters `aws cloudformation describe-stacks` writes. */
function readStackParameters(value: unknown): Readonly<Record<string, string>> {
  if (!Array.isArray(value)) {
    throw new Error(
      `${releaseEvidenceLayout.releaseRecord} is not the captured Stack[0].Parameters array ` +
        '(infra/README.md#create).',
    );
  }
  const parameters: Record<string, string> = {};
  for (const entry of value) {
    const record =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? (entry as Readonly<Record<string, unknown>>)
        : null;
    const key = record?.['ParameterKey'];
    const captured = record?.['ParameterValue'];
    if (typeof key === 'string' && typeof captured === 'string') {
      parameters[key] = captured;
    }
  }
  return parameters;
}

/** Describes one file of the release directory, failing when it is missing. */
async function readRecordedFile(outDir: string, file: string): Promise<ReleaseEvidenceFile> {
  const content = await readFile(path.join(outDir, file)).catch(() => {
    throw new Error(`The release directory has no ${file}.`);
  });
  return { file, bytes: content.byteLength, sha256: sha256(content) };
}

/** Re-reads one recorded artifact and fails when its bytes changed since packaging. */
async function verifyRecordedFile(outDir: string, recorded: ArtifactFile): Promise<void> {
  const target = path.resolve(outDir, recorded.file);
  const relative = path.relative(outDir, target);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`The manifest records the artifact ${recorded.file} outside the release.`);
  }
  const content = await readFile(target).catch(() => {
    throw new Error(
      `The release artifact ${recorded.file} recorded in the manifest is missing from the ` +
        'release directory.',
    );
  });
  if (content.byteLength !== recorded.bytes || sha256(content) !== recorded.sha256) {
    throw new Error(
      `The release artifact ${recorded.file} does not match the ${recorded.bytes} bytes and ` +
        'SHA-256 the manifest records.',
    );
  }
}

async function readJsonFile(outDir: string, file: string): Promise<unknown> {
  const content = await readFile(path.join(outDir, file)).catch(() => {
    throw new Error(`The release directory has no ${file}.`);
  });
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`${file} is not readable JSON.`);
  }
}

function readArtifactManifest(value: unknown): ArtifactManifest {
  const manifest = readRecord(value);
  const artifacts = readRecord(manifest?.['artifacts']);
  const browser = readRecord(artifacts?.['browser']);
  const browserFiles = browser?.['files'];
  if (
    manifest === null ||
    manifest['schema'] !== 1 ||
    typeof manifest['revision'] !== 'string' ||
    typeof manifest['version'] !== 'string' ||
    (manifest['workingTree'] !== 'clean' && manifest['workingTree'] !== 'dirty') ||
    browser === null ||
    !Array.isArray(browserFiles)
  ) {
    throw new Error(
      `${artifactLayout.manifest} is not the schema 1 packaging manifest this evidence command ` +
        'reads.',
    );
  }
  const settings = browser['settings'];
  const recorded: readonly unknown[] = [
    artifacts?.['backend'],
    ...browserFiles,
    ...(settings === null || settings === undefined ? [] : [settings]),
    artifacts?.['catalog'],
  ];
  for (const file of recorded) {
    readArtifactFile(file);
  }
  // Every background job's container definition is a release byte of its own: verified like the
  // module it packages (docs/release-checklist.md#source-completion).
  readArtifactFile(readRecord(artifacts?.['catalog'])?.['dockerfile']);
  return value as ArtifactManifest;
}

function readRecognitionManifest(value: unknown): RecognitionArtifactManifest {
  const manifest = readRecord(value);
  const files = manifest?.['context'];
  const browser = readRecord(manifest?.['browser']);
  const runtime = readRecord(browser?.['runtime']);
  const assets = browser?.['assets'];
  if (
    manifest === null ||
    manifest['schema'] !== 1 ||
    typeof manifest['revision'] !== 'string' ||
    typeof manifest['version'] !== 'string' ||
    (manifest['workingTree'] !== 'clean' && manifest['workingTree'] !== 'dirty') ||
    typeof manifest['baseImage'] !== 'string' ||
    !Array.isArray(files) ||
    browser === null ||
    runtime === null ||
    typeof runtime['version'] !== 'string' ||
    !Array.isArray(assets)
  ) {
    throw new Error(
      `${recognitionArtifactLayout.manifest} is not the schema 1 recognition manifest this ` +
        'evidence command reads.',
    );
  }
  readArtifactFile(manifest['source']);
  readArtifactFile(runtime);
  for (const file of files) {
    readArtifactFile(file);
  }
  for (const asset of assets) {
    readArtifactFile(asset);
  }
  return value as RecognitionArtifactManifest;
}

function readArtifactFile(value: unknown): ArtifactFile {
  const file = readRecord(value);
  if (
    typeof file?.['file'] !== 'string' ||
    typeof file['bytes'] !== 'number' ||
    typeof file['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(file['sha256'])
  ) {
    throw new Error('A manifest records an artifact without its path, byte size and SHA-256.');
  }
  return value as ArtifactFile;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function readOutDir(options: PrepareReleaseEvidenceOptions): string {
  if (typeof options?.outDir !== 'string' || options.outDir.length === 0) {
    throw new Error('The release evidence command requires the packaged release directory.');
  }
  return options.outDir;
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
      throw new Error(`Unsupported release-evidence flag ${flag ?? ''}.`);
    }
    if (value === undefined) {
      throw new Error('The --out flag requires a value.');
    }
    outDir = value;
    index += 1;
  }
  return { outDir };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = readCommandLine(process.argv.slice(2));
  const prepared = await prepareReleaseEvidence({ outDir: command.outDir });
  const destination = path.relative(repoRoot, prepared.evidencePath) || prepared.evidencePath;
  const { sourceCompletion, deployment, productionAcceptance } = prepared.evidence.stages;
  console.log(
    `Recorded release evidence for revision ${prepared.evidence.revision.slice(0, 12)} in ` +
      `${destination}: source completion ${sourceCompletion.status}, deployment ` +
      `${deployment.status}, production acceptance ${productionAcceptance.status}.`,
  );
}
