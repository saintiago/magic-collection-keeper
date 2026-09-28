/**
 * Verification of the prepared recognition assets (docs/operations.md#recognition-packaging,
 * docs/recognition.md#engines-and-assets).
 *
 * The retained engine is prepared at build time and pinned by committed manifests. This module owns
 * the single reading of those promises: the retained baseline digests of the shipped engine
 * sources, the model, catalog, OCR and title-name bytes, the pinned upstream CollectorVision
 * revision and its content, the browser runtime pin and the prepared browser assets including their
 * upstream identity, and the complete corresponding-source download of the checkout. Packaging
 * commands import it; it holds no command-line behavior of its own, so an import never runs a
 * packaging step.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import JSZip from 'jszip';

import { describeFile, repoRoot, type ArtifactFile } from './packaging-support.js';

/** Upper bound of the corresponding-source download the API returns. */
const sourceBundleLimit = 4_000_000;

/** Prefixes of the checkout `python/scripts/source_bundle.py` never copies into the download. */
const sourceBundleExcluded = [
  'data/',
  '.local-secrets/',
  'test-results/',
  'public/vendor/',
] as const;

/** Public artwork fixtures the download ships even though image bytes are otherwise excluded. */
const sourceBundleFixtures = ['adaptive.jpg', 'bolt.jpg', 'ring.jpg'] as const;

/** Generated upstream entries neither the download nor the image context ever carries. */
const generatedUpstreamEntries = new Set(['.git', '__pycache__', 'build', 'dist']);

/** Path of the retained Python package inside a checkout. */
export function preparedRecognitionRoot(root: string): string {
  return path.join(root, 'src', 'recognition', 'python');
}

/** Directory the prepared browser inference assets live in inside a checkout. */
export function preparedBrowserRoot(root: string): string {
  return path.join(root, 'src', 'recognition', 'browser', 'vendor');
}

export interface RecognitionEngineIdentity {
  /** Pinned upstream CollectorVision revision the visual pipeline was built from. */
  readonly code: string;
  /** ONNX model file name to SHA-256 of the verified weights. */
  readonly models: Readonly<Record<string, string>>;
  readonly catalog: {
    readonly key: string;
    readonly version: number;
    readonly rows: number;
    readonly embedding: string;
    readonly dimensions: number;
  };
  /** Converted ONNX text-model file name to SHA-256 of the verified file. */
  readonly ocr: Readonly<Record<string, string>>;
  readonly titleNames: ArtifactFile;
}

export interface RecognitionBrowserIdentity {
  readonly runtime: {
    readonly version: string;
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  /** Verified browser asset paths relative to the packaging output (artifacts/browser/vendor/…). */
  readonly assets: readonly ArtifactFile[];
}

export interface VerifiedRecognition {
  readonly engine: RecognitionEngineIdentity;
  readonly browser: RecognitionBrowserIdentity;
  readonly source: ArtifactFile;
}

/**
 * Verifies the prepared engine against its pinned manifests before anything is packaged: the
 * retained baseline digests of the engine sources, the pinned model/catalog/OCR/title-name bytes,
 * the pinned upstream CollectorVision revision, the browser runtime and asset digests, and the
 * corresponding-source download that names this checkout.
 */
export async function verifyPreparedRecognition(root: string): Promise<VerifiedRecognition> {
  const pythonRoot = preparedRecognitionRoot(root);
  const preparedRoot = path.join(pythonRoot, 'artifacts');
  if (
    !existsSync(path.join(pythonRoot, 'source.zip')) ||
    !existsSync(path.join(preparedRoot, 'artifact-manifest.json')) ||
    !existsSync(path.join(preparedRoot, 'weights'))
  ) {
    throw new Error(
      'The retained recognition assets are not prepared: run `npm run prepare:recognition` ' +
        '(docs/operations.md#recognition-packaging) before packaging the recognition release.',
    );
  }
  await verifyRetainedEngine(root);
  const pinned = await readPinnedEngine(pythonRoot);
  await verifySameFile(
    path.join(preparedRoot, 'artifact-manifest.json'),
    path.join(pythonRoot, 'artifact-manifest.json'),
  );
  const models = await verifyModels(preparedRoot, pinned.models);
  const catalog = await verifyCatalog(pythonRoot, preparedRoot, pinned.catalog);
  const ocr = await verifyOcr(pythonRoot, preparedRoot, pinned.ocr);
  const titleNames = await verifyTitleNames(pythonRoot, preparedRoot);
  await verifyCollectorVision(pythonRoot, pinned.code);
  const source = await verifySourceBundle(pythonRoot, pinned.code);
  const browser = await verifyBrowserVendor(root, pinned, {
    rows: pinned.catalog.rows,
    dimensions: catalog.dimensions,
    models,
    catalog,
  });
  return {
    engine: {
      code: pinned.code,
      models,
      catalog: { ...pinned.catalog, dimensions: catalog.dimensions },
      ocr,
      titleNames,
    },
    browser,
    source,
  };
}

/** The files the image runs besides the prepared assets; `smoke.py` is the packaged regression. */
export async function engineModules(pythonRoot: string): Promise<readonly string[]> {
  const modules: string[] = [];
  for (const name of (await readdir(pythonRoot)).sort()) {
    if (name.endsWith('.py')) {
      modules.push(name);
    }
  }
  for (const name of (await readdir(path.join(pythonRoot, 'adapters'))).sort()) {
    if (name.endsWith('.py')) {
      modules.push(`adapters/${name}`);
    }
  }
  modules.push('scripts/smoke.py');
  return modules;
}

interface PinnedEngine {
  readonly code: string;
  readonly models: Readonly<Record<string, string>>;
  readonly catalog: {
    readonly key: string;
    readonly version: number;
    readonly rows: number;
    readonly embedding: string;
  };
  readonly ocr: Readonly<Record<string, unknown>>;
}

/** The committed manifests of the retained engine; every prepared byte is checked against them. */
async function readPinnedEngine(pythonRoot: string): Promise<PinnedEngine> {
  const artifact = readRecord(
    await readJsonFile(path.join(pythonRoot, 'artifact-manifest.json')),
    'artifact-manifest.json',
  );
  const catalog = readRecord(artifact['catalog'], 'artifact-manifest.json catalog');
  return {
    code: readDigest(artifact, 'code', 'artifact-manifest.json code'),
    models: readDigests(artifact['models'], 'artifact-manifest.json models'),
    catalog: {
      key: readString(catalog, 'key', 'artifact-manifest.json catalog key'),
      version: readPositiveInteger(catalog, 'version', 'artifact-manifest.json catalog version'),
      rows: readPositiveInteger(catalog, 'rows', 'artifact-manifest.json catalog rows'),
      embedding: readString(catalog, 'embedding', 'artifact-manifest.json catalog embedding'),
    },
    ocr: readRecord(
      await readJsonFile(path.join(pythonRoot, 'ocr-models.json')),
      'ocr-models.json',
    ),
  };
}

/**
 * The retained engine sources of this checkout still match their pinned baseline, and every module
 * the image runs is one of them: the packaging step may assemble a build context, but it may not
 * ship unpinned engine code.
 */
async function verifyRetainedEngine(root: string): Promise<void> {
  const baseline = readRecord(
    JSON.parse(
      readFileSync(path.join(root, 'src', 'recognition', 'baseline.json'), 'utf8'),
    ) as unknown,
    'baseline.json',
  );
  const files = readRecord(baseline['files'], 'baseline.json files');
  for (const [target, entry] of Object.entries(files)) {
    if (!target.startsWith('src/recognition/python/')) {
      continue;
    }
    const expected = readDigest(readRecord(entry, target), 'sha256', `${target} sha256`);
    await expectDigest(path.join(root, target), expected);
  }
  for (const module of await engineModules(preparedRecognitionRoot(root))) {
    const target = `src/recognition/python/${module}`;
    const entry = readRecord(files[target], `${target} baseline entry`);
    await expectDigest(path.join(root, target), readDigest(entry, 'sha256', `${target} sha256`));
  }
}

async function verifyModels(
  preparedRoot: string,
  pinned: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const verified: Record<string, string> = {};
  for (const [name, digest] of Object.entries(pinned)) {
    await expectDigest(path.join(preparedRoot, 'weights', name), digest);
    verified[name] = digest;
  }
  if (Object.keys(verified).length === 0) {
    throw new Error('The pinned artifact manifest names no recognition model.');
  }
  return verified;
}

interface VerifiedCatalog {
  readonly dimensions: number;
  /** Directory of the pinned snapshot descriptor inside the prepared catalog. */
  readonly directory: string;
  readonly embeddings: { readonly file: string; readonly sha256: string };
  readonly records: { readonly file: string; readonly sha256: string };
}

/**
 * The catalog the engines search offline: the snapshot descriptor has to be the pinned version
 * and embedding, its embeddings/records bytes have to match their declared digests, and the cached
 * feed the retained loader reads in offline mode has to be the pinned one.
 */
async function verifyCatalog(
  pythonRoot: string,
  preparedRoot: string,
  pinned: PinnedEngine['catalog'],
): Promise<VerifiedCatalog> {
  await verifyCatalogFeed(pythonRoot, preparedRoot);
  const snapshot = path.join(
    preparedRoot,
    'catalog',
    'catalog-v2',
    'snapshots',
    pinned.key.split('/').join('--'),
    'metadata',
    `version-${pinned.version}`,
    'snapshot.json',
  );
  if (!existsSync(snapshot)) {
    throw new Error(
      `The prepared catalog does not carry version ${pinned.version} of ${pinned.key}.`,
    );
  }
  const descriptor = readRecord(await readJsonFile(snapshot), 'catalog snapshot descriptor');
  // CatalogV2Downloader._load_snapshot requires schema 2; the directory name alone does not
  // establish the identity returned by the retained loader.
  if (descriptor['schema'] !== 2) {
    throw new Error('The catalog snapshot does not use the supported schema 2.');
  }
  if (descriptor['version'] !== pinned.version || descriptor['catalog_key'] !== pinned.key) {
    throw new Error('The catalog snapshot does not carry the pinned catalog key and version.');
  }
  if (descriptor['metadata_loaded'] !== true) {
    throw new Error('The catalog snapshot does not contain the required metadata.');
  }
  if (readPositiveInteger(descriptor, 'rows', 'catalog snapshot rows') !== pinned.rows) {
    throw new Error(`The prepared catalog does not carry the pinned ${pinned.rows} rows.`);
  }
  const embedding = readRecord(descriptor['embedding'], 'catalog snapshot embedding');
  if (readString(embedding, 'model', 'catalog snapshot embedding model') !== pinned.embedding) {
    throw new Error('The prepared catalog does not use the pinned embedding model.');
  }
  const dimensions = readPositiveInteger(embedding, 'dimensions', 'catalog embedding dimensions');
  const feed = readRecord(
    await readJsonFile(path.join(pythonRoot, 'catalog-feed.json')),
    'catalog feed',
  );
  const families = readRecord(feed['families'], 'catalog feed families');
  const [familyName, ...localKey] = pinned.key.split('/');
  const family = readRecord(families[familyName ?? ''], 'catalog feed family');
  const catalogs = readRecord(family['catalogs'], 'catalog feed catalogs');
  const selection = readRecord(catalogs[localKey.join('/')], 'catalog feed selection');
  if (
    descriptor['family'] !== familyName ||
    canonical(embedding) !== canonical(family['embedding']) ||
    canonical(descriptor['descriptor']) !== canonical(selection['descriptor'])
  ) {
    throw new Error(
      'The catalog snapshot identity, embedding or descriptor differs from the pinned feed.',
    );
  }
  const assets = readRecord(descriptor['assets'], 'catalog snapshot assets');
  if (canonical(Object.keys(assets).sort()) !== canonical(['embeddings', 'records'])) {
    throw new Error('The catalog snapshot must contain exactly embeddings and records assets.');
  }
  const verified: Record<string, { file: string; sha256: string }> = {};
  for (const kind of ['embeddings', 'records'] as const) {
    const entry = readRecord(assets[kind], `catalog snapshot ${kind}`);
    const filename = readString(entry, 'filename', `catalog snapshot ${kind} filename`);
    if (path.posix.basename(filename) !== filename) {
      throw new Error(`The catalog snapshot ${kind} filename must name a local asset.`);
    }
    const digest = readDigest(entry, 'sha256', `catalog snapshot ${kind} sha256`);
    const bytes = readPositiveInteger(entry, 'size', `catalog snapshot ${kind} size`);
    const content = await readFile(path.join(path.dirname(snapshot), filename));
    if (content.byteLength !== bytes || sha256(content) !== digest) {
      throw new Error(`The catalog snapshot ${kind} fails its size or SHA-256 integrity check.`);
    }
    // The same compressed matrix is delivered to both engines. Its decoded shape must match
    // the receipt, as required by the retained Python loader and browser worker.
    if (kind === 'embeddings' && gunzipSync(content).byteLength !== pinned.rows * dimensions * 2) {
      throw new Error('The catalog snapshot embeddings do not match the declared matrix shape.');
    }
    verified[kind] = { file: filename, sha256: digest };
  }
  const embeddings = verified['embeddings'];
  const records = verified['records'];
  if (embeddings === undefined || records === undefined) {
    throw new Error('The catalog snapshot does not name its embeddings and records assets.');
  }
  return { dimensions, directory: path.dirname(snapshot), embeddings, records };
}

/**
 * The runtime dependency of offline catalog loading: the retained adapter loads the snapshot with
 * `offline=True`, which reads the feed the preparation step cached from the committed feed pin. A
 * prepared catalog without it fails at engine initialization.
 */
async function verifyCatalogFeed(pythonRoot: string, preparedRoot: string): Promise<void> {
  const cached = path.join(preparedRoot, 'catalog', 'catalog-v2', 'feed.json');
  if (!existsSync(cached)) {
    throw new Error(
      'The prepared catalog does not cache feed.json for offline loading: the retained loader ' +
        'needs the feed of `npm run prepare:recognition` ' +
        '(docs/operations.md#recognition-packaging).',
    );
  }
  const pinned = await readFile(path.join(pythonRoot, 'catalog-feed.json'));
  if (!(await readFile(cached)).equals(pinned)) {
    throw new Error(
      'The prepared catalog caches a different feed.json than the committed catalog-feed.json.',
    );
  }
}

/**
 * The converted text weights: the converter writes the pinned originals plus the ONNX detection,
 * recognition and dictionary files the runtime loads.
 */
async function verifyOcr(
  pythonRoot: string,
  preparedRoot: string,
  originals: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
  for (const [model, files] of Object.entries(originals)) {
    for (const [name, digest] of Object.entries(readDigests(files, `ocr-models.json ${model}`))) {
      await expectDigest(path.join(preparedRoot, 'ocr-models', model, name), digest);
    }
  }
  const converted = readRecord(
    await readJsonFile(path.join(preparedRoot, 'ocr-onnx.json')),
    'ocr-onnx.json',
  );
  if (canonical(converted['original']) !== canonical(originals)) {
    throw new Error('The converted text models do not name the pinned original weights.');
  }
  const files = readDigests(converted['files'], 'ocr-onnx.json files');
  for (const required of ['det.onnx', 'rec.onnx', 'latin.txt']) {
    if (!(required in files)) {
      throw new Error(`The converted text models are missing ${required}.`);
    }
  }
  for (const [name, digest] of Object.entries(files)) {
    await expectDigest(path.join(preparedRoot, 'ocr-onnx', name), digest);
  }
  await verifySameFile(
    path.join(preparedRoot, 'ocr-models.json'),
    path.join(pythonRoot, 'ocr-models.json'),
  );
  return files;
}

/** The pinned public title/printing name snapshot the engines read offline. */
async function verifyTitleNames(pythonRoot: string, preparedRoot: string): Promise<ArtifactFile> {
  const names = readRecord(
    await readJsonFile(path.join(pythonRoot, 'name-catalog.json')),
    'name-catalog.json',
  );
  await verifySameFile(
    path.join(preparedRoot, 'name-catalog.json'),
    path.join(pythonRoot, 'name-catalog.json'),
  );
  const digest = readDigest(names, 'sha256', 'name-catalog.json sha256');
  const file = path.join(preparedRoot, 'title-names.json.gz');
  await expectDigest(file, digest);
  return describeFile(preparedRoot, 'title-names.json.gz');
}

/**
 * The upstream CollectorVision revision the visual pipeline and the source bundle come from: the
 * prepared checkout stands at the pinned revision, every file it carries is that revision's own
 * content, and it carries no additional package file. Generated build output is skipped instead of
 * shipped, so the image context and the corresponding-source download hold exactly pinned upstream
 * code (docs/recognition.md#engines-and-assets).
 */
async function verifyCollectorVision(pythonRoot: string, code: string): Promise<void> {
  const vendor = path.join(pythonRoot, 'vendor', 'CollectorVision');
  if (!existsSync(path.join(vendor, '.git'))) {
    throw new Error(
      'The pinned CollectorVision source is missing: the retained preparation clones and pins it ' +
        '(`npm run prepare:recognition`).',
    );
  }
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: vendor, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('The prepared CollectorVision source is not a readable git checkout.');
  }
  if (head !== code) {
    throw new Error(
      `The prepared CollectorVision source is at ${head} instead of the pinned ${code}.`,
    );
  }
  const pinned = readPinnedTree(vendor, code);
  for (const [file, object] of pinned) {
    const source = path.join(vendor, file);
    if (!existsSync(source)) {
      throw new Error(`The prepared CollectorVision source is missing the pinned ${file}.`);
    }
    if (gitBlobId(await readFile(source)) !== object) {
      throw new Error(
        `The prepared CollectorVision source carries a modified ${file} instead of the pinned ` +
          `${code} content.`,
      );
    }
  }
  for (const file of await upstreamFiles(vendor)) {
    if (!pinned.has(file)) {
      throw new Error(
        `The prepared CollectorVision source carries ${file}, which the pinned revision ${code} ` +
          'does not contain.',
      );
    }
  }
}

/** The blob object id of every file of `revision`, by repository-relative path. */
function readPinnedTree(repository: string, revision: string): Map<string, string> {
  let listing: string;
  try {
    listing = execFileSync('git', ['ls-tree', '-r', '-z', revision], {
      cwd: repository,
      encoding: 'utf8',
    });
  } catch {
    throw new Error(`The pinned CollectorVision revision ${revision} is not a readable git tree.`);
  }
  const files = new Map<string, string>();
  for (const record of listing.split('\0')) {
    if (record === '') {
      continue;
    }
    const separator = record.indexOf('\t');
    if (separator < 0) {
      throw new Error(
        `The pinned CollectorVision revision ${revision} is not a readable git tree.`,
      );
    }
    const [mode, type, object] = record.slice(0, separator).split(' ');
    const file = record.slice(separator + 1);
    if (type !== 'blob' || object === undefined || (mode !== '100644' && mode !== '100755')) {
      throw new Error(
        `The pinned CollectorVision revision ${revision} carries the non-file entry ${file}.`,
      );
    }
    files.set(file, object);
  }
  if (files.size === 0) {
    throw new Error(`The pinned CollectorVision revision ${revision} carries no file.`);
  }
  return files;
}

/** The git object id of one file's bytes, so working-tree content compares to a tree entry. */
function gitBlobId(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

/**
 * Every upstream file the retained bundler and the image context carry, by path relative to the
 * checkout. The skipped entries are exactly the generated ones the bundler never packages.
 */
async function upstreamFiles(vendor: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(vendor, relative), { withFileTypes: true })) {
      if (isGeneratedUpstreamEntry(entry.name)) {
        continue;
      }
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      files.push(next);
    }
  }
  await walk('');
  return files.sort();
}

function isGeneratedUpstreamEntry(name: string): boolean {
  return generatedUpstreamEntries.has(name) || name.endsWith('.egg-info');
}

/** One entry the retained source bundler writes: exact bytes, or a generated index value. */
interface ExpectedSourceEntry {
  readonly bytes?: Buffer;
  readonly value?: unknown;
}

/**
 * The corresponding-source download of exactly this revision: the retained source bundler writes
 * it beside the engine, it stays inside the API download bound, and both its membership and its
 * bytes are the ones the bundling contract derives from this checkout — including the pinned
 * upstream source and the preparation inputs outside `src/recognition`.
 */
async function verifySourceBundle(pythonRoot: string, code: string): Promise<ArtifactFile> {
  const file = path.join(pythonRoot, 'source.zip');
  const bytes = (await stat(file)).size;
  if (bytes > sourceBundleLimit) {
    throw new Error(
      `The corresponding-source download is ${bytes} bytes and exceeds the ${sourceBundleLimit}-byte API bound.`,
    );
  }
  const expected = await expectedSourceBundle(pythonRoot, code);
  const archive = await JSZip.loadAsync(await readFile(file));
  for (const [name, entry] of Object.entries(archive.files)) {
    if (!entry.dir && !expected.has(name)) {
      throw new Error(
        `The corresponding-source download carries ${name}, which the retained bundler does not ` +
          'assemble from this checkout.',
      );
    }
  }
  for (const [name, entry] of expected) {
    const content = await archive.file(name)?.async('nodebuffer');
    if (content === undefined) {
      throw new Error(`The corresponding-source download does not carry ${name}.`);
    }
    if (entry.bytes !== undefined) {
      if (!content.equals(entry.bytes)) {
        throw new Error(
          `The corresponding-source download carries different ${name} bytes than this checkout.`,
        );
      }
      continue;
    }
    let actual: unknown;
    try {
      actual = JSON.parse(content.toString('utf8')) as unknown;
    } catch {
      throw new Error(`The corresponding-source download carries an unreadable ${name}.`);
    }
    if (indexKey(actual) !== indexKey(entry.value)) {
      throw new Error(
        `The corresponding-source download carries a stale ${name} for this checkout.`,
      );
    }
  }
  return describeFile(pythonRoot, 'source.zip');
}

/**
 * The exact contents the retained bundler writes for this checkout: every file it covers copied
 * under `keeper/`, the pinned upstream checkout under `CollectorVision/`, and the two generated
 * indexes it writes from both. The names and the bytes come from the same contracts the bundler
 * reads, so a download that omits, adds or rewrites an entry is a different download.
 */
async function expectedSourceBundle(
  pythonRoot: string,
  code: string,
): Promise<Map<string, ExpectedSourceEntry>> {
  const sources = readBundledSources(pythonRoot);
  const fixtures = new Set(
    sourceBundleFixtures.map((name) => `${sources.prefix}/fixtures/${name}`),
  );
  const entries = new Map<string, ExpectedSourceEntry>();
  const keeper: string[] = [];
  for (const name of sources.names) {
    if (name === '' || sourceBundleExcluded.some((excluded) => name.startsWith(excluded))) {
      continue;
    }
    keeper.push(name);
    if (isExcludedSourceFile(name) && !fixtures.has(name)) {
      continue;
    }
    const source = path.join(sources.root, name);
    if (!existsSync(source) || !statSync(source).isFile()) {
      continue;
    }
    entries.set(`keeper/${name}`, { bytes: readFileSync(source) });
  }
  entries.set('keeper/SOURCE_FILES.json', { value: keeper });
  entries.set(`keeper/${sources.prefix}-verified-ocr-onnx.json`, {
    bytes: await readFile(path.join(pythonRoot, 'artifacts', 'ocr-onnx.json')),
  });
  entries.set('COPYING', { bytes: await readFile(path.join(pythonRoot, 'LICENSE')) });
  const upstream = path.join(pythonRoot, 'vendor', 'CollectorVision');
  const media: Array<{ path: string; url: string; sha256: string }> = [];
  for (const file of await upstreamFiles(upstream)) {
    if (file.endsWith('.onnx')) {
      continue;
    }
    const content = await readFile(path.join(upstream, file));
    if (isDocumentationMedia(file)) {
      media.push({
        path: file,
        url: `https://raw.githubusercontent.com/HanClinto/CollectorVision/${code}/${file}`,
        sha256: sha256(content),
      });
      continue;
    }
    entries.set(`CollectorVision/${file}`, { bytes: content });
  }
  entries.set('CollectorVision/DOCUMENTATION_MEDIA.json', { value: media });
  return entries;
}

interface BundledSources {
  /** Checkout the download covers, discovered as the retained bundler discovers it. */
  readonly root: string;
  /** Package prefix the download writes the verified conversion manifest under. */
  readonly prefix: string;
  /** The names the bundler considers, from git or the checked-in source file list. */
  readonly names: readonly string[];
}

/**
 * The file list the retained bundler reads: the tracked files of the nearest checkout root, or the
 * checked-in source list of a checkout without git metadata. Both are read exactly as the bundler
 * reads them so the download can be verified against the same coverage.
 */
function readBundledSources(pythonRoot: string): BundledSources {
  let root = path.dirname(pythonRoot);
  for (let current = path.dirname(pythonRoot); ;) {
    if (
      existsSync(path.join(current, '.git')) ||
      existsSync(path.join(current, 'SOURCE_FILES.json'))
    ) {
      root = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const prefix = path.relative(root, pythonRoot).split(path.sep).join('/');
  if (existsSync(path.join(root, '.git'))) {
    const listing = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    return { root, prefix, names: listing.split('\0') };
  }
  if (!existsSync(path.join(root, 'SOURCE_FILES.json'))) {
    throw new Error(
      'The corresponding-source download cannot be verified: the checkout carries neither git ' +
        'metadata nor a source file list.',
    );
  }
  const listed = JSON.parse(readFileSync(path.join(root, 'SOURCE_FILES.json'), 'utf8')) as unknown;
  if (!Array.isArray(listed) || listed.some((name) => typeof name !== 'string')) {
    throw new Error('The corresponding-source file list does not name the checkout files.');
  }
  return { root, prefix, names: listed as string[] };
}

/** Binary fixtures the bundler keeps out of the download unless they are public artwork. */
function isExcludedSourceFile(name: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.zip'].some((suffix) => name.endsWith(suffix));
}

/** Documentation media of the pinned upstream checkout, listed by URL and digest instead of bytes. */
function isDocumentationMedia(file: string): boolean {
  return (
    file.startsWith('docs/') &&
    ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(path.posix.extname(file).toLowerCase())
  );
}

/**
 * The generated indexes compare by content: each entry has to be present exactly once, while the
 * bundler's own traversal order is not part of the promise.
 */
function indexKey(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value.map(canonical).sort()) : canonical(value);
}

/**
 * The browser inference assets the preserved modules resolve next to themselves: the pinned ONNX
 * Runtime Web runtime and the catalog/model bytes the browser worker verifies at load.
 */
async function verifyBrowserVendor(
  root: string,
  pinned: PinnedEngine,
  catalog: {
    readonly rows: number;
    readonly dimensions: number;
    readonly models: Readonly<Record<string, string>>;
    readonly catalog: VerifiedCatalog;
  },
): Promise<RecognitionBrowserIdentity> {
  const vendor = preparedBrowserRoot(root);
  if (!existsSync(path.join(vendor, 'visual', 'manifest.json'))) {
    throw new Error(
      'The prepared browser recognition assets are missing: run `npm run prepare:recognition` ' +
        '(docs/operations.md#recognition-packaging).',
    );
  }
  const pin = await readBrowserRuntimePin(root);
  const assets: ArtifactFile[] = [];
  const manifest = readRecord(
    await readJsonFile(path.join(vendor, 'visual', 'manifest.json')),
    'browser visual manifest',
  );
  if (manifest['schema'] !== 1) {
    throw new Error('The browser visual manifest does not use the supported schema.');
  }
  if (manifest['rows'] !== catalog.rows || manifest['dims'] !== catalog.dimensions) {
    throw new Error(
      'The browser visual manifest does not carry the pinned catalog rows and width.',
    );
  }
  verifyBrowserUpstream(manifest, pinned);
  const declared = readRecord(manifest['assets'], 'browser visual assets');
  const expected: Readonly<Record<string, string>> = {
    cornelius: 'cornelius.onnx',
    milo: 'milo.onnx',
  };
  for (const name of ['cornelius', 'milo', 'embeddings', 'records']) {
    const spec = readRecord(declared[name], `browser visual asset ${name}`);
    const file = readString(spec, 'file', `browser visual asset ${name} file`);
    const digest = readDigest(spec, 'sha256', `browser visual asset ${name} sha256`);
    const bytes = readPositiveInteger(spec, 'bytes', `browser visual asset ${name} bytes`);
    if (file !== `${digest}.onnx` && file !== `${digest}.gz`) {
      throw new Error(`The browser visual asset ${name} is not named after its digest.`);
    }
    const content = await readFile(path.join(vendor, 'visual', file));
    if (content.byteLength !== bytes || sha256(content) !== digest) {
      throw new Error(`The browser visual asset ${name} (${file}) fails its integrity check.`);
    }
    if (name === 'embeddings') {
      // The embeddings are the pinned catalog bytes; the records are the compact re-export below.
      if (digest !== catalog.catalog.embeddings.sha256) {
        throw new Error('The browser visual embeddings are not the pinned catalog asset.');
      }
    } else if (name === 'records') {
      await verifyBrowserRecords(
        path.join(vendor, 'visual', file),
        path.join(catalog.catalog.directory, catalog.catalog.records.file),
        catalog.rows,
      );
    } else {
      const model = expected[name];
      if (model === undefined || digest !== catalog.models[model]) {
        throw new Error(`The browser visual asset ${name} is not the pinned model.`);
      }
    }
    assets.push({ file: `visual/${file}`, bytes, sha256: digest });
  }
  const runtime = readRecord(
    await readJsonFile(path.join(vendor, 'ort', 'runtime.json')),
    'browser runtime manifest',
  );
  const runtimeFile = readString(runtime, 'file', 'browser runtime file');
  if (
    readString(runtime, 'version', 'browser runtime version') !== pin.version ||
    runtimeFile !== pin.runtime.file
  ) {
    throw new Error('The browser runtime manifest does not name the pinned ONNX Runtime Web.');
  }
  if (
    readPositiveInteger(runtime, 'bytes', 'browser runtime bytes') !== pin.runtime.bytes ||
    readDigest(runtime, 'sha256', 'browser runtime sha256') !== pin.runtime.sha256
  ) {
    throw new Error('The browser runtime manifest does not carry the pinned runtime digest.');
  }
  const modules: Record<string, string> = { [runtimeFile]: pin.runtime.sha256, ...pin.modules };
  for (const [name, digest] of Object.entries(modules)) {
    await expectDigest(path.join(vendor, 'ort', name), digest);
    assets.push({ ...(await describeFile(path.join(vendor, 'ort'), name)), file: `ort/${name}` });
  }
  return {
    runtime: {
      version: pin.version,
      file: runtimeFile,
      bytes: pin.runtime.bytes,
      sha256: pin.runtime.sha256,
    },
    assets: assets
      .map((asset) => ({ ...asset, file: `browser/vendor/${asset.file}` }))
      .sort((left, right) => left.file.localeCompare(right.file)),
  };
}

/**
 * The upstream identity the browser worker reports with every reading: it reads the revision and
 * catalog from the manifest, so a missing or substituted identity either breaks inference or
 * attributes the reading to a different engine than the packaged one.
 */
function verifyBrowserUpstream(
  manifest: Readonly<Record<string, unknown>>,
  pinned: PinnedEngine,
): void {
  const upstream = readRecord(manifest['upstream'], 'browser visual manifest upstream');
  if (readDigest(upstream, 'code', 'browser visual manifest upstream code') !== pinned.code) {
    throw new Error('The browser visual manifest does not name the pinned upstream revision.');
  }
  if (canonical(upstream['models']) !== canonical(pinned.models)) {
    throw new Error('The browser visual manifest does not name the pinned recognition models.');
  }
  if (canonical(upstream['catalog']) !== canonical(pinned.catalog)) {
    throw new Error('The browser visual manifest does not name the pinned catalog.');
  }
}

/**
 * The browser catalog rows are the deterministic compact projection of the pinned catalog records:
 * the same rows in the same order with the identity, name, finishes and printing metadata the
 * browser search uses. The re-export is compressed by the retained script, so its rows — not its
 * compressed bytes — are what has to match the pinned snapshot.
 */
async function verifyBrowserRecords(
  browserFile: string,
  catalogFile: string,
  rows: number,
): Promise<void> {
  const browser = JSON.parse(gunzipSync(await readFile(browserFile)).toString('utf8')) as unknown;
  const records = gunzipSync(await readFile(catalogFile))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (!Array.isArray(browser) || browser.length !== rows || records.length !== rows) {
    throw new Error('The browser catalog does not carry the pinned rows.');
  }
  for (let index = 0; index < records.length; index += 1) {
    const projected = browserRow(browser[index], index);
    const pinned = catalogRecord(records[index], index);
    if (canonical(projected) !== canonical(pinned)) {
      throw new Error(`The browser catalog diverges from the pinned catalog at row ${index}.`);
    }
  }
}

/** One browser search row, in the compact shape the retained export writes. */
function browserRow(value: unknown, index: number): readonly unknown[] {
  const row = readRecord(value, `browser catalog row ${index}`);
  return ['id', 'oracle_id', 'name', 'finishes', 'set', 'collector_number', 'lang'].map(
    (key) => row[key] ?? null,
  );
}

/** The same fields of one pinned catalog record, including the record's own identifiers. */
function catalogRecord(line: string | undefined, index: number): readonly unknown[] {
  const record = readRecord(JSON.parse(line ?? 'null') as unknown, `catalog record ${index}`);
  const identifiers = readRecord(
    record['identifiers'] ?? {},
    `catalog record ${index} identifiers`,
  );
  const metadata = readRecord(record['metadata'] ?? {}, `catalog record ${index} metadata`);
  return [
    record['id'] ?? null,
    identifiers['scryfall_oracle'] ?? null,
    record['name'] ?? null,
    record['finishes'] ?? null,
    metadata['set'] ?? null,
    metadata['collector_number'] ?? null,
    metadata['lang'] ?? null,
  ];
}

export interface RecognitionRuntimePin {
  readonly schema: 1;
  readonly package: string;
  readonly version: string;
  readonly runtime: { readonly file: string; readonly bytes: number; readonly sha256: string };
  readonly modules: Readonly<Record<string, string>>;
}

/**
 * The ONNX Runtime Web files of the pinned dependency the preserved browser modules resolve. The
 * delivery build copies exactly these bytes beside the preserved modules; a dependency update has
 * to update this pin deliberately.
 */
export async function readBrowserRuntimePin(
  root: string = repoRoot,
): Promise<RecognitionRuntimePin> {
  const pin = readRecord(
    await readJsonFile(path.join(root, 'src', 'recognition', 'browser-runtime.json')),
    'browser-runtime.json',
  );
  if (pin['schema'] !== 1) {
    throw new Error('The browser runtime pin does not use the supported schema.');
  }
  const runtime = readRecord(pin['runtime'], 'browser-runtime.json runtime');
  return {
    schema: 1,
    package: readString(pin, 'package', 'browser-runtime.json package'),
    version: readString(pin, 'version', 'browser-runtime.json version'),
    runtime: {
      file: readString(runtime, 'file', 'browser-runtime.json runtime file'),
      bytes: readPositiveInteger(runtime, 'bytes', 'browser-runtime.json runtime bytes'),
      sha256: readDigest(runtime, 'sha256', 'browser-runtime.json runtime sha256'),
    },
    modules: readDigests(pin['modules'], 'browser-runtime.json modules'),
  };
}

async function verifySameFile(actual: string, expected: string): Promise<void> {
  const left = await readFile(actual);
  const right = await readFile(expected);
  if (!left.equals(right)) {
    throw new Error(
      `${path.basename(actual)} in the prepared artifacts is not the committed ${path.basename(expected)}.`,
    );
  }
}

async function expectDigest(file: string, expected: string): Promise<void> {
  if (!existsSync(file)) {
    throw new Error(`The prepared recognition assets are missing ${file}.`);
  }
  const digest = sha256(await readFile(file));
  if (digest !== expected) {
    throw new Error(`${file} does not match its pinned SHA-256 ${expected} (found ${digest}).`);
  }
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function readRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Readonly<Record<string, unknown>>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} is not a non-empty string.`);
  }
  return value;
}

function readDigest(record: Readonly<Record<string, unknown>>, key: string, what: string): string {
  const value = readString(record, key, what);
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new Error(`${what} is not a revision or SHA-256 digest.`);
  }
  return value;
}

function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  what: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${what} is not a positive integer.`);
  }
  return value;
}

function readDigests(value: unknown, what: string): Record<string, string> {
  const record = readRecord(value, what);
  const digests: Record<string, string> = {};
  for (const [name, digest] of Object.entries(record)) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${what} does not name a SHA-256 digest for ${name}.`);
    }
    digests[name] = digest;
  }
  if (Object.keys(digests).length === 0) {
    throw new Error(`${what} names no file.`);
  }
  return digests;
}

/** Order-independent form of a parsed manifest, so a rewritten copy still compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
