/**
 * Verification of the prepared recognition assets (docs/operations.md#recognition-packaging,
 * docs/recognition.md#engines-and-assets).
 *
 * The retained engine is prepared at build time and pinned by committed manifests. This module owns
 * the single reading of those promises: the retained baseline digests of the shipped engine
 * sources, the model, catalog, OCR and title-name bytes, the pinned upstream CollectorVision
 * revision, the browser runtime pin and the prepared browser assets, and the corresponding-source
 * download of the checkout. Packaging commands import it; it holds no command-line behavior of its
 * own, so an import never runs a packaging step.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import JSZip from 'jszip';

import { describeFile, repoRoot, type ArtifactFile } from './packaging-support.js';

/** Upper bound of the corresponding-source download the API returns. */
const sourceBundleLimit = 4_000_000;

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
  const catalog = await verifyCatalog(preparedRoot, pinned.catalog);
  const ocr = await verifyOcr(pythonRoot, preparedRoot, pinned.ocr);
  const titleNames = await verifyTitleNames(pythonRoot, preparedRoot);
  await verifyCollectorVision(pythonRoot, pinned.code);
  const source = await verifySourceBundle(root, pythonRoot);
  const browser = await verifyBrowserVendor(root, {
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
 * and embedding, and its embeddings/records bytes have to match their declared digests.
 */
async function verifyCatalog(
  preparedRoot: string,
  pinned: PinnedEngine['catalog'],
): Promise<VerifiedCatalog> {
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
  if (readPositiveInteger(descriptor, 'rows', 'catalog snapshot rows') !== pinned.rows) {
    throw new Error(`The prepared catalog does not carry the pinned ${pinned.rows} rows.`);
  }
  const embedding = readRecord(descriptor['embedding'], 'catalog snapshot embedding');
  if (readString(embedding, 'model', 'catalog snapshot embedding model') !== pinned.embedding) {
    throw new Error('The prepared catalog does not use the pinned embedding model.');
  }
  const dimensions = readPositiveInteger(embedding, 'dimensions', 'catalog embedding dimensions');
  const assets = readRecord(descriptor['assets'], 'catalog snapshot assets');
  const verified: Record<string, { file: string; sha256: string }> = {};
  for (const kind of ['embeddings', 'records'] as const) {
    const entry = readRecord(assets[kind], `catalog snapshot ${kind}`);
    const filename = readString(entry, 'filename', `catalog snapshot ${kind} filename`);
    const digest = readDigest(entry, 'sha256', `catalog snapshot ${kind} sha256`);
    await expectDigest(path.join(path.dirname(snapshot), filename), digest);
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

/** The upstream CollectorVision revision the visual pipeline and the source bundle come from. */
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
}

/**
 * The corresponding-source download of exactly this revision: the retained source bundler writes
 * it beside the engine, it stays inside the API download bound, and every recognition source file
 * it carries has to match the checkout the image is built from.
 */
async function verifySourceBundle(root: string, pythonRoot: string): Promise<ArtifactFile> {
  const file = path.join(pythonRoot, 'source.zip');
  const bytes = (await stat(file)).size;
  if (bytes > sourceBundleLimit) {
    throw new Error(
      `The corresponding-source download is ${bytes} bytes and exceeds the ${sourceBundleLimit}-byte API bound.`,
    );
  }
  const archive = await JSZip.loadAsync(await readFile(file));
  for (const required of [
    'COPYING',
    'keeper/SOURCE_FILES.json',
    'keeper/src/recognition/python/handler.py',
    'keeper/src/recognition/python/lambda_entry.py',
    'CollectorVision/DOCUMENTATION_MEDIA.json',
  ]) {
    if (archive.file(required) === null) {
      throw new Error(`The corresponding-source download does not carry ${required}.`);
    }
  }
  for (const name of Object.keys(archive.files).sort()) {
    if (!name.startsWith('keeper/src/recognition/')) {
      continue;
    }
    const source = name.slice('keeper/'.length);
    const content = await archive.file(name)?.async('nodebuffer');
    if (content === undefined) {
      continue;
    }
    // The bundler copies the checkout and adds the verified conversion manifest under its own
    // name; every other recognition entry has to be the file this checkout carries.
    const expectedFile =
      name === 'keeper/src/recognition/python-verified-ocr-onnx.json'
        ? path.join(pythonRoot, 'artifacts', 'ocr-onnx.json')
        : path.join(root, source);
    if (!existsSync(expectedFile)) {
      throw new Error(
        `The corresponding-source download carries ${name}, which this checkout does not have.`,
      );
    }
    const expected = readFileSync(expectedFile);
    if (!content.equals(expected)) {
      throw new Error(
        `The corresponding-source download carries a different ${source} than this checkout.`,
      );
    }
  }
  return describeFile(pythonRoot, 'source.zip');
}

/**
 * The browser inference assets the preserved modules resolve next to themselves: the pinned ONNX
 * Runtime Web runtime and the catalog/model bytes the browser worker verifies at load.
 */
async function verifyBrowserVendor(
  root: string,
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
